import { formatBytes, formatDuration, MS_PER_CORE_HOUR } from '../units.ts';
import { shareLabel } from '../finding-presentation.ts';
import { computeAllocation } from '../allocation.ts';
import { computeEfficiencyModel } from '../efficiency-model.ts';
import { runTiming } from '../run-timing.ts';
import { executorHeapPeaks } from '../executor-peaks.ts';
import { computePeakConcurrentCores } from '../core-count.ts';
import { smallestCoresWithinTolerance } from '../scaling-sim.ts';
import { computeWallClock } from '../wall-clock.ts';
import { walkPlanTree } from '../plan-tree-walk.ts';
import { computeCoreLocalityRatio, NON_LOCAL_TIERS } from '../core-locality-ratio.ts';
import {
  EXECUTOR_STARTUP_OVERHEAD_MS, NETWORK_FETCH_PENALTY_MS, RE_READ_THROUGHPUT_BPS, costOnly, noWasteModel,
  withAssumptions,
} from '../impact-model.ts';
import { totalExecutorCpuMs } from '../run-totals.ts';
import { decreaseConf, increaseConf } from '../remediation.ts';
import type { Finding, ImpactEstimate, PlanNode } from '../types.ts';
import { dynamicAllocationOff, effectiveConf, loggedAs } from './conf.ts';
import {
  autoscalingChurnConfidence, cacheSampleConfidence, cachingReuseConfidence, coreLocalityConfidence,
  memoryWasteConfidence,
} from './confidence.ts';
import { defineAppDetector } from './define.ts';
import { idleCapacityFix, setConfUnlessLogged, switchFix } from './fixes.ts';
import { FILES_READ_BYTES, findCompositeCandidates, relationIdOf } from './plan-shape.ts';
import type { DetectorApp, DetectorRddInfo } from './types.ts';
import { MB } from './units.ts';

const LOG_STAGE_EXECUTOR_METRICS_KEY = 'spark.eventLog.logStageExecutorMetrics';

// Shared by cacheUtilization's two variants, worded per storage source: neither is a runtime
// block-access read-count.
const CACHE_UTILIZATION_VALIDATION = {
  rddInfo: "This ratio is a point-in-time storage snapshot from stage-submission events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
  blockUpdates: "This ratio is the RDD's peak cache residency rebuilt from block-update events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
} as const;

/** A sentence names a cached RDD by its first 40 characters, since RDD names are often a whole
 * plan string (the Cache Storage card shows it in full); an unnamed RDD reads "RDD <id>". */
function rddLabel({ id, name }: DetectorRddInfo): string {
  return `RDD ${!name ? id : name.length > 40 ? `${name.slice(0, 40)}...` : name}`;
}

function partialCacheFinding(rdd: DetectorRddInfo, cachedRatio: number, impactBand: 'warning' | 'info'): Finding {
  const cachedPct = Math.round(cachedRatio * 100);
  const evictedPct = 100 - cachedPct;
  return {
    type: 'cacheUtilization', variant: 'partialCache', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'cachedRatio', value: cachedPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${evictedPct}% evicted from cache (${cachedPct}% of partitions cached): increase executor memory or reduce the cached dataset size.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

function diskSpilloverFinding(rdd: DetectorRddInfo, diskRatio: number, impactBand: 'warning' | 'info'): Finding {
  const diskPct = Math.round(diskRatio * 100);
  return {
    type: 'cacheUtilization', variant: 'diskSpillover', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'diskRatio', value: diskPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${diskPct}% spilled to disk despite requesting MEMORY_AND_DISK: executor memory may be too small for it.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

// Persisted RDDs with no storage evidence at all: no block updates in the log, and RDD Info's
// sizes are the 0 that Spark 2.3+ always writes. Reports the gap instead of a clean result, the
// same missing-evidence shape as memoryUtilization's dataUnavailable caveat.
function storageUnobservedFinding(persistedRddCount: number, app: DetectorApp | null): Finding {
  const rdds = persistedRddCount === 1 ? '1 persisted RDD has' : `${persistedRddCount} persisted RDDs have`;
  return {
    type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null,
    impactBand: 'info', metric: 'persistedRdds', value: persistedRddCount, dataUnavailable: true,
    recommendation: `${rdds} no cache-storage evidence in this log, so eviction and disk spillover can't be checked: Spark 2.3+ records cached sizes only as block updates, which need spark.eventLog.logBlockUpdates.enabled=true.`,
    remediation: setConfUnlessLogged(app, 'spark.eventLog.logBlockUpdates.enabled', true),
  };
}

const LOCALITY_WAIT_KEY = 'spark.locality.wait';
const LOCAL_TIERS = new Set(['PROCESS_LOCAL', 'NODE_LOCAL']);

export const utilizationDetector = defineAppDetector({
  type: 'utilization', order: 100, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['utilization'],
  docAnchor: '#bottleneck-utilization',
  // Idle share grades: the finding fires under `minUtil` busy; the verdict note and the Scorecard
  // flag read idle at `1 - minUtil` as notable and at `1 - criticalUtil` as critical.
  thresholds: { minUtil: 0.60, criticalUtil: 0.30 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved, runAggregates } = ctx;
    const appDuration = runTiming(app).durationMs;
    if (!app || executorsAdded.length === 0 || appDuration == null) return null;
    // Capacity is what the run was allocated (cores x time alive, the figure behind
    // metrics.allocation.coreHours), not peak concurrent cores x the whole run: under dynamic
    // allocation or late-joining executors that is more than was ever held, and the idle figure
    // would exceed the allocation. Null without executor cores.
    const { allocatedCoreMs: capacityCoreMs, utilization } = computeEfficiencyModel({
      app, stages: ctx.stages, executorsAdded, executorsRemoved, runAggregates,
    });
    if (capacityCoreMs == null || utilization == null) return null;
    // Peak concurrent cores (not computeTotalCores, a cumulative sum that double-counts a
    // churned-through executor against its replacement): the cluster size the finding reports.
    const totalCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
    // Utilization is busy core-time (from the whole-run core-time-series) over the allocation, not
    // executor lifetime: an executor that exists for the whole run but sits fully idle must not
    // score as 100% used. Missing runAggregates (older callers, synthetic fixtures) reads as 0 busy time.
    if (utilization >= thresholds.minUtil) return null;

    // CPU-time-based utilization: metric only, no threshold.
    // Null when no stage recorded CPU time (older Spark), the same rule as the CLI metrics block.
    const cpuMs = totalExecutorCpuMs(ctx.stages.values());
    const cpuUtilizationPct = cpuMs == null ? null : Math.round((cpuMs / capacityCoreMs) * 100);

    const value = Math.round(utilization * 100);
    const fix = idleCapacityFix(app, 'consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation',
      'dynamic allocation is already on, so consider reducing cluster size');
    return {
      type: 'utilization', stageId: null, impactBand: 'warning',
      metric: 'avgUtilization', value,
      utilizationFraction: utilization,
      appDurationMs: appDuration,
      totalCores,
      allocatedCoreMs: capacityCoreMs,
      cpuUtilizationPct,
      recommendation: `Average executor utilization was only ${value}%: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate(finding): ImpactEstimate | null {
    const fraction = finding.utilizationFraction as number | undefined;
    const allocatedMs = finding.allocatedCoreMs as number | undefined;
    if (fraction == null || allocatedMs == null) {
      return costOnly('measured');
    }
    // The same allocated-minus-busy figure as `rawWaste`, in core-milliseconds, next to (never in)
    // coreTimeMs: that field is busy task time a fix removes, this is capacity no task used.
    const idleMs = (1 - fraction) * allocatedMs;
    return {
      ...costOnly('measured', { value: idleMs / MS_PER_CORE_HOUR, unit: 'coreHours', idle: true }),
      idleCoreTimeMs: { low: idleMs, high: idleMs },
    };
  },
});

export const rightSizingDetector = defineAppDetector({
  // The what-if scaling model (scaling-sim.ts) as a recommendation: the smallest core count whose
  // modeled stage time stays within tolerance of the observed one. `utilization` measures idle
  // allocation; this names the size the stages' own parallelism needs. The model is idealized, so
  // the finding is always low confidence and silent when the model misses the observed run.
  type: 'rightSizing', order: 101, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['rightSizing'],
  docAnchor: '#bottleneck-utilization',
  thresholds: { tolerancePct: 10, maxCoreShare: 0.75, minBaselineCores: 8, maxModelErrorPct: 20 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved, runAggregates, stages } = ctx;
    const perStage = runAggregates?.perStage;
    if (!app || !perStage || !runTiming(app).complete) return null;
    const observedCores = computePeakConcurrentCores(app, executorsAdded, executorsRemoved);
    if (observedCores < thresholds.minBaselineCores) return null;
    const observedActiveMs = computeWallClock(app, stages).stagesActive;
    const fit = smallestCoresWithinTolerance({ perStage, baselineCores: observedCores, observedActiveMs, tolerancePct: thresholds.tolerancePct });
    if (fit == null || fit.modelErrorPct > thresholds.maxModelErrorPct) return null;
    if (fit.cores > observedCores * thresholds.maxCoreShare) return null;

    const fix = idleCapacityFix(app, 'consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation',
      'dynamic allocation is already on, so consider reducing cluster size');
    return {
      type: 'rightSizing', stageId: null, impactBand: 'warning',
      metric: 'rightSizedCores', value: fit.cores,
      observedCores, observedActiveMs, modeledActiveMs: fit.estMakespanMs, modelErrorPct: fit.modelErrorPct,
      confidence: 'low',
      validationRequired: `The model spreads each stage's tasks evenly over the cores and ignores scheduling and shuffle costs. At ${observedCores} cores it misses the real time by ${fit.modelErrorPct}%. The scaling card can show a different error, because it counts every executor ever added. Re-run with fewer cores to check.`,
      recommendation: `At its peak the run held ${observedCores} cores. A simple model predicts that about ${fit.cores} would run the stages in ${formatDuration(fit.estMakespanMs)}, within ${thresholds.tolerancePct}% of the ${formatDuration(observedActiveMs)} they took: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate: noWasteModel,
});

export const memoryUtilizationDetector = defineAppDetector({
  type: 'memoryUtilization', order: 102, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['memoryUtilization'],
  docAnchor: '#bottleneck-memory-utilization',
  thresholds: {
    idleCoreWarn: 0.50,          // idle share of allocated core time above which idleCores fires
    bandTooHigh: 0.70,           // below this => over-provisioned (cost signal)
    wasteBufferMultiplier: 1.5,  // wasted memory-time must exceed used by this multiple
  },
  detect(ctx, thresholds): Finding[] {
    const { app, executorsAdded, executorsRemoved, runAggregates, stages } = ctx;
    const out: Finding[] = [];
    const appDurationMs = runTiming(app).durationMs;
    if (app == null || appDurationMs == null) return out;

    const allocatedMB = app.resources?.executor?.memoryMB ?? null;

    // Idle-cores rate: the same idle share `utilization` reads, so the two findings of one idle condition agree.
    const allocationInput = { app, stages, executors: { added: executorsAdded, removed: executorsRemoved } };
    const { idleShare: idleRate } = computeEfficiencyModel({ app, stages, executorsAdded, executorsRemoved, runAggregates });
    if (runAggregates?.busyCoreMs != null && idleRate != null) {
      if (idleRate > thresholds.idleCoreWarn) {
        const value = Math.round(idleRate * 100);
        const { memoryGbHours } = computeAllocation(allocationInput);
        const fix = idleCapacityFix(app, 'either reduce cluster size (spark.executor.instances) or enable dynamic allocation',
          'dynamic allocation is already on, so reduce cluster size');
        out.push({
          type: 'memoryUtilization', variant: 'idleCores', stageId: null,
          impactBand: 'warning', metric: 'idleCoreRate', value,
          // Raw (unrounded) rate plus the allocated memory-time for the impact estimator: `value` is rounded pct.
          idleRateFraction: idleRate,
          allocatedMBSeconds: memoryGbHours != null ? memoryGbHours * 1024 * 3600 : null,
          recommendation: `${value}% of available core-time ran no task: ${fix.text}.`,
          remediation: fix.remediation,
        });
      }
    }

    // Memory band (executor only: there is no driver heap metric).
    // spark.executor.memory is one setting for every executor, so the judgement is made once, on
    // the executor with the highest sampled heap peak. A near-capacity peak is not reported:
    // JVMHeapMemory counts uncollected garbage, so a peak near -Xmx is normal JVM behaviour.
    const peakHeapByExec = executorHeapPeaks(ctx);
    if (peakHeapByExec.size === 0) {
      // Spark 3.0+ writes the executor's metric peaks on every TaskEnd, but it samples them at the
      // executor heartbeat (spark.executor.metrics.pollingInterval defaults to 0), so a task that
      // finishes between two heartbeats reports zeros, as does every task in local mode.
      // spark.eventLog.logStageExecutorMetrics logs the per-stage peaks the driver gathers.
      const stageMetrics = switchFix(loggedAs(app, LOG_STAGE_EXECUTOR_METRICS_KEY, true), LOG_STAGE_EXECUTOR_METRICS_KEY, true,
        ` To measure it, set ${LOG_STAGE_EXECUTOR_METRICS_KEY}=true to record the peaks per stage.`,
        ` ${LOG_STAGE_EXECUTOR_METRICS_KEY} is already on, so no executor ran long enough to be sampled.`);
      out.push({
        type: 'memoryUtilization', variant: 'memoryBand', stageId: null,
        impactBand: 'info', metric: 'memoryBand', dataUnavailable: true,
        recommendation: `Executor heap peaks are missing from this log: Spark samples them at the executor heartbeat, so tasks shorter than the heartbeat interval report zeros (and local mode reports zeros throughout), and executor memory sizing was not measured.${stageMetrics.text}`,
        remediation: stageMetrics.remediation,
      });
    } else if (allocatedMB != null && allocatedMB > 0) {
      const allocatedBytes = allocatedMB * 1024 * 1024;
      let execId = '';
      let heap = 0;
      for (const [id, peak] of peakHeapByExec) {
        if (peak > heap) { heap = peak; execId = id; }
      }
      const ratio = heap / allocatedBytes;
      if (ratio < thresholds.bandTooHigh) {
        const pct = Math.round(ratio * 100);
        const executorCount = peakHeapByExec.size;
        out.push({
          type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned',
          stageId: null, executorId: execId,
          impactBand: 'info', metric: 'heapUsedRatio', value: pct,
          // Absolute figures behind the rounded ratio, for the estimator's unused-memory model:
          // the unused heap is held by every executor for as long as it is alive.
          allocatedBytes, heap, executorCount,
          executorSeconds: computeAllocation({ app, stages, executors: { added: executorsAdded, removed: executorsRemoved } }).executorSeconds
            ?? executorCount * (appDurationMs / 1000),
          recommendation: `The busiest of ${executorCount} sampled executors peaked at ${pct}% of allocated heap (a lower bound: Spark samples at executor heartbeat): memory may be over-provisioned; consider reducing spark.executor.memory for cost savings.`,
          remediation: [decreaseConf('spark.executor.memory')],
        });
      }
    }

    // Spark Memory Limit waste model.
    // executorRunTime sums task time across cores, so dividing by the cores per executor gives
    // executor-seconds: the same unit as the allocated executor-seconds it is compared with.
    // The allocated side is the executors' alive time (computeAllocation), not the peak executor
    // count held for the whole run: under dynamic allocation the two differ by peak over mean.
    const allocation = computeAllocation(allocationInput);
    const executorCores = app.resources?.executor?.cores ?? allocation.executorCores;
    if (allocatedMB != null && allocation.executorSeconds != null && allocation.executorSeconds > 0 && executorCores != null && executorCores > 0) {
      const allocatedMBSeconds = allocatedMB * allocation.executorSeconds;
      let usedRunTimeMs = 0;
      for (const s of stages.values()) usedRunTimeMs += s.executorRunTime ?? 0;
      const usedMBSeconds = allocatedMB * (usedRunTimeMs / 1000 / executorCores);
      const wastedMBSeconds = allocatedMBSeconds - usedMBSeconds;
      if (wastedMBSeconds > thresholds.wasteBufferMultiplier * usedMBSeconds) {
        const value = Math.round(wastedMBSeconds);
        out.push({
          type: 'memoryUtilization', variant: 'wasteModel', stageId: null,
          impactBand: 'info', metric: 'wastedMBSeconds', value, allocatedMBSeconds,
          confidence: memoryWasteConfidence(wastedMBSeconds, usedMBSeconds, thresholds.wasteBufferMultiplier),
          validationRequired: `Memory-waste estimate uses allocated-vs-used memory-time and a ${thresholds.wasteBufferMultiplier}x buffer: confirm against the Spark UI before acting.`,
          recommendation: `Allocated executor memory sat largely idle over the run (~${value.toLocaleString('en-US')} MB-seconds wasted): review spark.executor.memory and executor count.`,
          remediation: [decreaseConf('spark.executor.memory')],
        });
      }
    }

    return out;
  },
  estimate(finding): ImpactEstimate | null {
    // The wasteModel variant reports metric: 'wastedMBSeconds', value: <MB-seconds>.
    if (finding.variant === 'wasteModel' && typeof finding.value === 'number') {
      return costOnly('measured', { value: finding.value, unit: 'mbSeconds' });
    }
    if (finding.variant === 'idleCores') {
      // Idle core-time priced as memory held but unused: the allocated memory-seconds times the idle rate.
      const idleRateFraction = finding.idleRateFraction as number | undefined;
      const allocatedMBSeconds = finding.allocatedMBSeconds as number | null | undefined;
      if (idleRateFraction != null && allocatedMBSeconds != null) {
        const wastedMBSeconds = idleRateFraction * allocatedMBSeconds;
        return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
      }
      return costOnly('modeled');
    }
    // Only the over-provisioned band is a waste; the dataUnavailable shape has no inputs and
    // stays informational.
    if (finding.variant === 'memoryBand' && finding.rule === 'heapOverProvisioned') {
      const allocatedBytes = finding.allocatedBytes as number | undefined;
      const heap = finding.heap as number | undefined;
      const executorSeconds = finding.executorSeconds as number | undefined;
      if (allocatedBytes != null && heap != null && executorSeconds != null) {
        const unusedMB = (allocatedBytes - heap) / (1024 * 1024);
        const wastedMBSeconds = unusedMB * executorSeconds;
        return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
      }
    }
    return costOnly('modeled');
  },
});

export const cacheUtilizationDetector = defineAppDetector({
  // Per-RDD cache-utilization proxies (this repo's own design: Spark event logs carry no
  // block-access events, so a literal cache hit rate isn't derivable). Two per-RDD tiered
  // checks over rddInfo: partial caching and disk spillover. An RDD can produce both. rddInfo's
  // sizes come from SparkListenerBlockUpdated when the log has it, else from StageSubmitted's
  // RDD Info (0 since Spark 2.3; Spark 1.x fills it only on StageCompleted); with neither, on
  // Spark 2.3+ with logBlockUpdates off, a storageUnobserved caveat replaces them.
  type: 'cacheUtilization', order: 103, bandPolicy: 'own', fixEffort: 'code', version: 2,
  emits: ['cacheUtilization'],
  docAnchor: '#bottleneck-cache-utilization',
  thresholds: {
    cachedRatioWarn: 0.50, cachedRatioInfo: 0.90,
    diskRatioWarn: 0.40, diskRatioInfo: 0.15,
  },
  detect(ctx, thresholds): Finding[] | null {
    const rddInfo = ctx.app?.rddInfo;
    if (!(rddInfo instanceof Map)) return null;
    const out: Finding[] = [];
    let persistedRddCount = 0;
    // With block-update logging on, zero rdd_* updates means nothing was ever cached, not a gap.
    const blockUpdatesLogged = loggedAs(ctx.app, 'spark.eventLog.logBlockUpdates.enabled', true);
    // Spark before 2.3 has no block-update logging and writes RDD Info's cache figures only on
    // StageCompleted, which isn't read: the caveat's advice doesn't apply there. A log with no
    // version is pre-1.3 (no SparkListenerLogStart); every 2.3+ log records one.
    const version = /^(\d+)\.(\d+)/.exec(ctx.app?.sparkVersion ?? '');
    const preBlockUpdates = version == null || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 3);
    let anyStorageEvidence = blockUpdatesLogged || preBlockUpdates || (ctx.app?.rddBlockUpdates ?? 0) > 0;
    for (const rdd of rddInfo.values()) {
      const sl = rdd.storageLevel ?? {};
      if (!(sl.useMemory || sl.useDisk)) continue;
      persistedRddCount++;
      if (!((rdd.numCachedPartitions ?? 0) > 0)) continue;
      anyStorageEvidence = true;

      if ((rdd.numPartitions ?? 0) > 0) {
        const cachedRatio = rdd.numCachedPartitions / rdd.numPartitions;
        if (cachedRatio < thresholds.cachedRatioWarn) out.push(partialCacheFinding(rdd, cachedRatio, 'warning'));
        else if (cachedRatio < thresholds.cachedRatioInfo) out.push(partialCacheFinding(rdd, cachedRatio, 'info'));
      }

      if (sl.useMemory && sl.useDisk) {
        const total = (rdd.memorySize ?? 0) + (rdd.diskSize ?? 0);
        if (total > 0) {
          const diskRatio = (rdd.diskSize ?? 0) / total;
          if (diskRatio > thresholds.diskRatioWarn) out.push(diskSpilloverFinding(rdd, diskRatio, 'warning'));
          else if (diskRatio > thresholds.diskRatioInfo) out.push(diskSpilloverFinding(rdd, diskRatio, 'info'));
        }
      }
    }
    if (persistedRddCount > 0 && !anyStorageEvidence) out.push(storageUnobservedFinding(persistedRddCount, ctx.app));
    return out;
  },
  estimate(finding): ImpactEstimate | null {
    // storageUnobserved reports missing evidence: no sizes, so nothing to model.
    if (finding.variant === 'storageUnobserved') return costOnly('none');
    const memorySize = (finding.memorySize as number | undefined) ?? 0;
    const diskSize = (finding.diskSize as number | undefined) ?? 0;
    const numCachedPartitions = (finding.numCachedPartitions as number | undefined) ?? 0;
    const numPartitions = (finding.numPartitions as number | undefined) ?? 0;
    const numUncachedPartitions = Math.max(0, numPartitions - numCachedPartitions);
    const cachedBytes = memorySize + diskSize;
    // Extrapolate never-cached partitions' size from the CACHED partitions' average (uncached/
    // cached, not uncached/total: numCachedPartitions produced cachedBytes). diskSize is added
    // once more: those bytes are cached but on disk, so re-reading them still costs I/O like an uncached partition.
    const uncachedBytes = numCachedPartitions > 0 ? (cachedBytes / numCachedPartitions) * numUncachedPartitions : 0;
    const uncachedOrSpilledBytes = uncachedBytes + diskSize;
    const wasteMs = (uncachedOrSpilledBytes / RE_READ_THROUGHPUT_BPS) * 1000;
    return withAssumptions(
      costOnly('modeled', { value: wasteMs, unit: 'ms' }),
      `assumes ${Math.round(RE_READ_THROUGHPUT_BPS / 1e6)} MB/s per reading task, summed as task time and not divided over executors`,
    );
  },
});

export const coreLocalityDetector = defineAppDetector({
  // Non-local task ratio across stage.localityStats (RACK_LOCAL + ANY vs all tasks), the other
  // half of the "Wasted Cores Ratio" (idle-core half is memoryUtilization's idleCores).
  // NO_PREF stays in the denominator only: shuffle-read stages legitimately report it.
  type: 'coreLocality', order: 103, bandPolicy: 'own', fixEffort: 'config', version: 1,
  emits: ['coreLocality'],
  docAnchor: '#bottleneck-core-locality',
  thresholds: { minTasks: 50, warnRatio: 0.15, critRatio: 0.35 },
  detect(ctx, thresholds): Finding | null {
    const { totalTasks, nonLocalTasks, ratio, topStages } = computeCoreLocalityRatio([...ctx.stages.values()]);
    if (totalTasks == null || totalTasks < thresholds.minTasks) return null;
    // computeCoreLocalityRatio only returns ratio:null together with totalTasks:null (shared
    // EMPTY sentinel); the totalTasks guard above rules that out, so ratio is non-null here.
    if (ratio! < thresholds.warnRatio) return null;

    const value = Math.round(ratio! * 100);
    const hosts = new Set(ctx.executorsAdded.flatMap((e) => (e.host ? [e.host] : []))).size;
    const worst = topStages.filter((s) => s.nonLocalTasks > 0).slice(0, 3).map((s) => `stage ${s.stageId} (${Math.round(s.ratio * 100)}% of ${s.taskCount})`).join(', ');
    const wait = effectiveConf(ctx.app, LOCALITY_WAIT_KEY);
    const hasLocalSlots = [...ctx.stages.values()]
      .filter((s) => s.localityStats?.some((l) => NON_LOCAL_TIERS.has(l.locality) && l.count > 0))
      .some((s) => s.localityStats!.some((l) => LOCAL_TIERS.has(l.locality) && l.count > 0));
    const waitAdvice = hasLocalSlots
      ? `Raise ${LOCALITY_WAIT_KEY}${wait ? ` (${wait})` : ''} so the scheduler waits longer for a local slot, or run executors on the hosts that hold the data.`
      : `No task in the stages with non-local tasks reached process- or node-local placement, so no data-local executor exists and a longer ${LOCALITY_WAIT_KEY}${wait ? ` (${wait})` : ''} only delays each task: run executors on the hosts that hold the data.`;
    return {
      type: 'coreLocality', stageId: null,
      impactBand: ratio! >= thresholds.critRatio ? 'critical' : 'warning',
      metric: 'nonLocalRatio', value,
      // Raw count behind the ratio, for the impact estimator. Non-null whenever totalTasks is.
      nonLocalTaskCount: nonLocalTasks!,
      confidence: coreLocalityConfidence(ratio!, totalTasks, thresholds),
      validationRequired: `Flagged when at least ${shareLabel(thresholds.warnRatio)} of tasks run non-local (critical at ${shareLabel(thresholds.critRatio)}), on runs of ${thresholds.minTasks}+ tasks.`,
      recommendation: `${value}% of tasks (${nonLocalTasks!}) ran without process- or node-local data placement${hosts > 0 ? ` on a run of ${hosts} ${hosts === 1 ? 'host' : 'hosts'}` : ''}`
        + `${worst ? `, highest in ${worst}` : ''}. ${waitAdvice}`,
      remediation: hasLocalSlots ? [increaseConf(LOCALITY_WAIT_KEY)] : [],
    };
  },
  estimate(finding): ImpactEstimate | null {
    const nonLocal = (finding.nonLocalTaskCount as number | undefined) ?? 0;
    return withAssumptions(
      costOnly('modeled', { value: nonLocal * NETWORK_FETCH_PENALTY_MS, unit: 'coreMs' }),
      `assumes ${NETWORK_FETCH_PENALTY_MS} ms of extra core time per non-local task; the log has no measured fetch cost`,
    );
  },
});

export const autoscalingChurnDetector = defineAppDetector({
  // Short-lived executors: stood up and torn down before doing useful work (wasteful
  // re-provisioning, not normal scale-down). Reuses utilization's add/remove matching, but
  // measures lifetime against a threshold instead of aggregate active-time.
  type: 'autoscalingChurn', order: 103, bandPolicy: 'own', fixEffort: 'config', version: 2,
  emits: ['autoscalingChurn'],
  docAnchor: '#bottleneck-autoscaling-churn',
  thresholds: { shortLivedMs: 120_000, warningPct: 0.30, criticalPct: 0.60, minExecutors: 5 },
  detect(ctx, thresholds): Finding | null {
    const { app, executorsAdded, executorsRemoved } = ctx;
    if (!app || executorsAdded.length === 0 || !runTiming(app).complete) return null;

    const removedAt = new Map<string, number>();
    for (const ev of executorsRemoved) removedAt.set(ev.executorId, ev.timestamp);

    // Only executors with a removal event have a measured lifetime. One still alive at app end
    // was never torn down, so it counts in neither the numerator nor the denominator.
    let removedCount = 0;
    let shortLivedCount = 0;
    for (const ev of executorsAdded) {
      const endedAt = removedAt.get(ev.executorId);
      if (endedAt === undefined) continue;
      removedCount++;
      if (endedAt - ev.timestamp < thresholds.shortLivedMs) shortLivedCount++;
    }
    if (removedCount < thresholds.minExecutors) return null;

    const shortLivedPct = shortLivedCount / removedCount;
    const impactBand = shortLivedPct > thresholds.criticalPct ? 'critical'
                      : shortLivedPct > thresholds.warningPct ? 'warning' : null;
    if (!impactBand) return null;

    const pct = Math.round(shortLivedPct * 100);
    const daOff = dynamicAllocationOff(app);
    return {
      type: 'autoscalingChurn', stageId: null, impactBand,
      metric: 'shortLivedExecutorPct', value: pct,
      // Raw count behind the percentage, for the impact estimator's startup-overhead figure.
      shortLivedExecutorCount: shortLivedCount,
      confidence: autoscalingChurnConfidence(shortLivedPct, thresholds.warningPct, thresholds.criticalPct),
      // No dynamic-allocation property has an effect when the run's conf turns it off (as for coldStart).
      dynamicAllocation: daOff ? 'off' : 'on',
      recommendation: daOff
        ? `${pct}% of removed executors ran for under 2 minutes: dynamic allocation is off, so the churn comes from executors lost or preempted, not from autoscaling bounds; check the cluster manager's preemption and executor-loss logs.`
        : `${pct}% of removed executors ran for under 2 minutes: this looks like wasteful re-provisioning rather than normal scale-down; consider raising spark.dynamicAllocation.executorIdleTimeout or widening the minExecutors/maxExecutors bounds to reduce flapping.`,
      remediation: daOff ? [] : [
        increaseConf('spark.dynamicAllocation.executorIdleTimeout'),
        decreaseConf('spark.dynamicAllocation.minExecutors'),
        increaseConf('spark.dynamicAllocation.maxExecutors'),
      ],
    };
  },
  estimate(finding): ImpactEstimate | null {
    const shortLived = (finding.shortLivedExecutorCount as number | undefined) ?? 0;
    const executorHours = (shortLived * EXECUTOR_STARTUP_OVERHEAD_MS) / 3.6e6;
    return costOnly('modeled', { value: executorHours, unit: 'coreHours' });
  },
});

export const cachingOpportunityDetector = defineAppDetector({
  // Cross-execution relation reuse: flags an input relation scanned by two or more SQL
  // executions in one run, firing on real relation names (parquet:..., jdbc:...).
  type: 'cachingOpportunity', order: 105, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['cachingOpportunity'],
  docAnchor: '#bottleneck-caching-opportunity',
  thresholds: { minExecutions: 2 },
  detect(ctx, thresholds): Finding[] | null {
    const sql = ctx.sql;
    if (!(sql instanceof Map) || sql.size === 0) return null;

    interface RelationAgg {
      format: string; relation: string;
      executionIds: Set<number>; executionBytes: Map<number, number>;
    }
    interface PerExecCompositeAgg {
      operator: 'join' | 'union'; node: PlanNode;
      leafRelationBytes: Map<string, number>; ancestorFingerprints: Set<string>;
    }
    interface ByCompositeAgg {
      operator: 'join' | 'union'; exampleNode: PlanNode;
      executionIds: Set<number>; executionBytes: Map<number, number>;
      ancestorFingerprints: Set<string>; leafRelationRids: Set<string>;
    }
    interface CompositeResolution { finalExecutionIds: Set<number>; suppressed: boolean; }

    const byRelation = new Map<string, RelationAgg>();
    for (const exec of sql.values()) {
      if (!exec.planTree) continue;
      // Dedupe relations within one execution (self-joins count once), summing read bytes per relation.
      const perExec = new Map<string, number>();
      walkPlanTree(exec.planTree, (node) => {
        const rid = relationIdOf(node);
        if (!rid) return;
        const bytesMetric = (node.metrics ?? []).find(m => m.name === FILES_READ_BYTES);
        perExec.set(rid, (perExec.get(rid) ?? 0) + (bytesMetric ? bytesMetric.value : 0));
      });
      for (const [rid, bytes] of perExec) {
        let agg = byRelation.get(rid);
        if (!agg) {
          const colon = rid.indexOf(':');
          agg = { format: rid.slice(0, colon), relation: rid.slice(colon + 1), executionIds: new Set(), executionBytes: new Map() };
          byRelation.set(rid, agg);
        }
        agg.executionIds.add(exec.id);
        agg.executionBytes.set(exec.id, (agg.executionBytes.get(exec.id) ?? 0) + bytes);
      }
    }

    const byComposite = new Map<string, ByCompositeAgg>();
    for (const exec of sql.values()) {
      if (!exec.planTree) continue;
      const candidates = findCompositeCandidates(exec.planTree);
      const fingerprintByNode = new Map<PlanNode, string>(candidates.map((c): [PlanNode, string] => [c.node, c.fingerprint]));

      // Dedupe identical fingerprints within this execution (repeated composite counts once).
      const perExecComposite = new Map<string, PerExecCompositeAgg>();
      for (const c of candidates) {
        let agg = perExecComposite.get(c.fingerprint);
        if (!agg) {
          agg = {
            operator: c.operator, node: c.node,
            leafRelationBytes: new Map(),
            ancestorFingerprints: new Set(
              c.ancestorNodes.map(n => fingerprintByNode.get(n)).filter((fp): fp is string => Boolean(fp)),
            ),
          };
          perExecComposite.set(c.fingerprint, agg);
        }
        for (const [rid, bytes] of c.leafRelationBytes) {
          agg.leafRelationBytes.set(rid, (agg.leafRelationBytes.get(rid) ?? 0) + bytes);
        }
      }

      for (const [fingerprint, agg] of perExecComposite) {
        let cAgg = byComposite.get(fingerprint);
        if (!cAgg) {
          cAgg = {
            operator: agg.operator, exampleNode: agg.node,
            executionIds: new Set(), executionBytes: new Map(),
            ancestorFingerprints: new Set(), leafRelationRids: new Set(),
          };
          byComposite.set(fingerprint, cAgg);
        }
        cAgg.executionIds.add(exec.id);
        const execBytes = [...agg.leafRelationBytes.values()].reduce((sum, b) => sum + b, 0);
        cAgg.executionBytes.set(exec.id, (cAgg.executionBytes.get(exec.id) ?? 0) + execBytes);
        for (const af of agg.ancestorFingerprints) cAgg.ancestorFingerprints.add(af);
        for (const rid of agg.leafRelationBytes.keys()) cAgg.leafRelationRids.add(rid);
      }
    }

    // Qualifying = enough distinct executions on its own. Nested-dedupe: a qualifying composite
    // with a qualifying ANCESTOR is subsumed, fully (equal sets) or partially (residual).
    const isQualifying = (fp: string): boolean =>
      byComposite.has(fp) && byComposite.get(fp)!.executionIds.size >= thresholds.minExecutions;
    const compositeResolutions = new Map<string, CompositeResolution>();
    for (const [fingerprint, agg] of byComposite) {
      if (!isQualifying(fingerprint)) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: true }); continue; }
      const qualifyingAncestors = [...agg.ancestorFingerprints].filter(isQualifying).map(fp => byComposite.get(fp)!);
      if (qualifyingAncestors.length === 0) { compositeResolutions.set(fingerprint, { finalExecutionIds: agg.executionIds, suppressed: false }); continue; }
      const coveredByAncestors = new Set(qualifyingAncestors.flatMap(outer => [...outer.executionIds]));
      const residual = new Set([...agg.executionIds].filter(id => !coveredByAncestors.has(id)));
      if (residual.size === 0) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
      else if (residual.size < thresholds.minExecutions) compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: true });
      else compositeResolutions.set(fingerprint, { finalExecutionIds: residual, suppressed: false });
    }

    const relationDisplayName = (rid: string): string => rid.slice(rid.indexOf(':') + 1);
    const compositeVerb: Record<'join' | 'union', [string, string]> = { join: ['joined', 'join'], union: ['unioned', 'union'] };

    const out: Finding[] = [];
    // rid -> Set<execId> covered by an emitted composite, for leaf suppression.
    const coveredExecutionsByRid = new Map<string, Set<number>>();
    for (const [fingerprint, agg] of byComposite) {
      const resolution = compositeResolutions.get(fingerprint)!;
      if (resolution.suppressed) continue;
      const finalExecutionIds = [...resolution.finalExecutionIds].sort((a, b) => a - b);
      const totalReadBytes = finalExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
      const rids = [...agg.leafRelationRids].sort();
      if (rids.length === 0) continue;
      const relations = rids.map(rid => {
        const colon = rid.indexOf(':');
        return { relation: rid.slice(colon + 1), format: rid.slice(0, colon) };
      });
      const [verb, connector] = compositeVerb[agg.operator];
      const relationDisplay = rids.map(relationDisplayName).join(` ${connector} `);
      const value = finalExecutionIds.length;
      const recommendation = totalReadBytes >= 128 * MB
        ? `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the ${verb} DataFrame so it is computed once.`
        : `${verb[0].toUpperCase()}${verb.slice(1)} result read by ${value} queries: cache the ${verb} DataFrame, or reconsider whether it needs to be recomputed each time.`;

      out.push({
        type: 'cachingOpportunity', variant: 'composite', stageId: null, impactBand: 'info',
        metric: 'executionReuse', value,
        format: 'derived', relations, operator: agg.operator, relation: relationDisplay,
        executionIds: finalExecutionIds, totalReadBytes,
        confidence: cachingReuseConfidence(value, thresholds.minExecutions),
        validationRequired:
          'Composite reuse is inferred from a structural plan-shape match (operator + normalized ' +
          'join/filter condition + child shapes) across SQL executions; confirm these executions ' +
          'truly compute the same join/union before caching.',
        recommendation,
      });

      for (const rid of rids) {
        if (!coveredExecutionsByRid.has(rid)) coveredExecutionsByRid.set(rid, new Set());
        for (const id of finalExecutionIds) coveredExecutionsByRid.get(rid)!.add(id);
      }
    }

    for (const [rid, agg] of byRelation) {
      const covered = coveredExecutionsByRid.get(rid);
      const residualExecutionIds = covered
        ? [...agg.executionIds].filter(id => !covered.has(id))
        : [...agg.executionIds];
      if (residualExecutionIds.length < thresholds.minExecutions) continue;
      const value = residualExecutionIds.length;
      const totalReadBytes = residualExecutionIds.reduce((sum, id) => sum + (agg.executionBytes.get(id) ?? 0), 0);
      const recommendation = totalReadBytes >= 128 * MB
        ? `Read by ${value} queries (~${formatBytes(totalReadBytes)}): cache/persist the shared DataFrame so it is scanned once.`
        : `Read by ${value} queries: cache the shared DataFrame, or broadcast it if it is a small join lookup.`;
      out.push({
        type: 'cachingOpportunity', stageId: null, impactBand: 'info',
        metric: 'executionReuse', value,
        relation: agg.relation, format: agg.format,
        executionIds: residualExecutionIds.sort((a, b) => a - b),
        totalReadBytes,
        confidence: cachingReuseConfidence(value, thresholds.minExecutions),
        validationRequired:
          'Relation-reuse is inferred from the pre-AQE plan scan identity across SQL ' +
          'executions; confirm the reads are the same data and cacheable within one ' +
          'session before acting.',
        recommendation,
      });
    }
    return out;
  },
  estimate(finding): ImpactEstimate | null {
    const totalReadBytes = (finding.totalReadBytes as number | undefined) ?? 0;
    // The measured scan volume and the query count, not a time: the bytes are cumulative task
    // input across queries, and a re-read cost depends on how much of it a cache would serve.
    const queries = (finding.executionIds as number[] | undefined)?.length ?? 0;
    return withAssumptions(
      costOnly('measured', { value: totalReadBytes, unit: 'bytes', reread: true }),
      `counts the bytes ${queries} ${queries === 1 ? 'query' : 'queries'} scanned from the same relation, matched by plan; a cache would still read it once`,
    );
  },
});
