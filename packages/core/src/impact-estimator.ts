import type { Finding, ImpactEstimate, ImpactEstimateMethod, RawWasteFigure, Stage } from './types.ts';
import {
  computeOccupancy, estimateSingleStage, estimateMultiStage,
  type OccupancyStage, type SingleStageEstimateOptions, type StageOccupancyInfo,
} from './occupancy.ts';
import { detectorCatalog } from './detectors.ts';

// Assumed shuffle-network throughput per executor link, ~1 Gbps. Starting assumption, unvalidated.
const SHUFFLE_THROUGHPUT_BPS = 125_000_000;
// Assumed disk I/O throughput per executor for spilled data, ~200 MB/s (conservative HDD/SSD blend).
const SPILL_IO_THROUGHPUT_BPS = 200_000_000;

// Both constants above are single-device figures (one NIC, one local disk). A stage's shuffle
// reads and spills are spread over every executor that ran its tasks, each moving its own share
// in parallel, so the stage's aggregate bandwidth scales with that executor count. Dividing a
// stage-wide byte total by one device's bandwidth modeled the whole cluster as one link: on 14
// real logs that claimed up to 1,870s of shuffle time on stages whose tasks measured ~0s of
// shuffle fetch wait (222 of 284 shuffle findings). No executor data falls back to one device.
function stageIoParallelism(stage: Stage): number {
  const executors = Array.isArray(stage.executorStats) ? stage.executorStats.length : 0;
  return Math.max(1, executors);
}
// Spark's classic recommended shuffle partition size.
const IDEAL_BYTES_PER_PARTITION_TASK = 128 * 1024 * 1024;
// Assumed per-task scheduling/launch overhead.
const TASK_SCHEDULING_OVERHEAD_MS = 50;
// Assumed per-file open latency (small-file overhead).
const FILE_OPEN_OVERHEAD_MS = 10;
// Assumed broadcast-transfer bandwidth, shared with overBroadcast/underBroadcast.
const BROADCAST_BANDWIDTH_BPS = 125_000_000;
// Assumed per-non-local-task network-fetch penalty, reported as extra core-time.
const NETWORK_FETCH_PENALTY_MS = 20;
// Assumed executor JVM+container startup overhead.
const EXECUTOR_STARTUP_OVERHEAD_MS = 15000;
// Assumed re-read throughput, shared by cachingOpportunity and cacheUtilization.
const RE_READ_THROUGHPUT_BPS = 125_000_000;

// stageSlowness flags a stage at `infoMin` minutes; that's the floor for the waste this estimate
// reports. Read from the detector's catalog entry so the two stay in sync automatically.
const STAGE_SLOWNESS_THRESHOLD_MINUTES = (() => {
  const infoMin = detectorCatalog().find((d) => d.type === 'stageSlowness')?.thresholds?.infoMin;
  if (typeof infoMin !== 'number') {
    throw new Error("impact-estimator: stageSlowness detector's 'infoMin' threshold not found in detectorCatalog()");
  }
  return infoMin;
})();

// skew and straggler claim time off the stage's longest task itself, so the occupancy clip must
// not floor them at that same task (see estimateSingleStage). detectors.ts's clippedWasteMs gates
// both detectors on the same option so the firing floor and the displayed estimate agree.
const TAIL_CLAIM: SingleStageEstimateOptions = { shortensLongestTask: true };

// No quantifiable magnitude -> 'informational'; a rawWaste figure with no stage window ->
// 'resourceOnly'. Never a fake {low:0, high:0}: wallClock is null in both cases.
function costOnly(estimateMethod: ImpactEstimateMethod, rawWaste?: RawWasteFigure): ImpactEstimate {
  return rawWaste
    ? { basis: 'resourceOnly', wallClock: null, estimateMethod, rawWaste }
    : { basis: 'informational', wallClock: null, estimateMethod };
}

function singleStageImpact(
  wasteMs: number,
  stageId: number,
  stages: Map<number, Stage>,
  occupancy: Map<number, StageOccupancyInfo>,
  estimateMethod: ImpactEstimateMethod,
  rawWaste?: RawWasteFigure,
  opts?: SingleStageEstimateOptions,
): ImpactEstimate {
  const est = estimateSingleStage(wasteMs, stageId, stages as unknown as Map<number, OccupancyStage>, occupancy, opts);
  if (est) return { basis: est.basis, wallClock: est.wallClock, estimateMethod, rawWaste };
  return costOnly(estimateMethod, rawWaste); // stage excluded from the sweep (duration <= 0)
}

function stageMappableWasteOrCostOnly(
  wasteMs: number,
  stageIds: number[] | undefined,
  stages: Map<number, Stage>,
  occupancy: Map<number, StageOccupancyInfo>,
): ImpactEstimate {
  const rawWaste: RawWasteFigure | undefined = wasteMs > 0 ? { value: wasteMs, unit: 'ms' } : undefined;
  if (!stageIds || stageIds.length === 0) {
    return costOnly('modeled', rawWaste);
  }
  // One waste event spread over a span of stages, not N independent wastes: apportion evenly so
  // estimateMultiStage's union cap doesn't absorb the same amount claimed once per stage.
  const perStageWasteMs = wasteMs / stageIds.length;
  const wasteMsByStage = new Map(stageIds.map((id) => [id, perStageWasteMs]));
  const est = estimateMultiStage(stageIds, wasteMsByStage, stages as unknown as Map<number, OccupancyStage>, occupancy);
  if (!est) return costOnly('modeled', rawWaste); // every stage excluded from the sweep
  return { basis: est.basis, wallClock: est.wallClock, estimateMethod: 'modeled', rawWaste };
}

/** Per-finding-type dispatch. A type with no case stays uncovered (no impactEstimate attached);
 * docs/architecture.md's Impact estimation table is the authoritative completeness check, not this switch. */
function computeEstimateForFinding(
  finding: Finding,
  stages: Map<number, Stage>,
  occupancy: Map<number, StageOccupancyInfo>,
): ImpactEstimate | null {
  switch (finding.type) {
    case 'retryWaste': {
      // The waste figure lives on the Stage, not the Finding: the detector only re-publishes it as metric/value.
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = (stage.retryWasteMs as number | undefined) ?? 0;
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'measured', { value: wasteMs, unit: 'ms' });
    }
    case 'speculationWaste': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = (stage.speculationWasteMs as number | undefined) ?? 0;
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'measured', { value: wasteMs, unit: 'ms' });
    }
    case 'coldStart': {
      // The detector reports the gap as `metric: 'startupGapSeconds', value: <seconds>`.
      if (typeof finding.value !== 'number') return null;
      const wasteMs = finding.value * 1000;
      // Time before any task starts can never overlap any stage; a genuine unclipped point estimate,
      // not tied to any stage's gate (coldStart is app-scoped, stageId: null).
      return { basis: 'serial', wallClock: { low: wasteMs, high: wasteMs }, estimateMethod: 'measured' };
    }
    case 'gc': {
      // The low-GC branch is an over-provisioning signal whose fix (less executor memory) raises
      // GC rather than recovering it: the stage's GC time is no saving there, so no waste model.
      if (finding.direction === 'low') return costOnly('none');
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      const executorRunTime = stage.executorRunTime ?? 0;
      const jvmGCTime = stage.jvmGCTime ?? 0;
      // The raw cross-task core-time sum, before any conversion: the one figure here
      // that is straight from the log rather than modeled.
      const rawWaste = { value: jvmGCTime, unit: 'coreMs' } as const;
      if (executorRunTime <= 0 || stageDurationMs <= 0) {
        return costOnly('modeled', rawWaste);
      }
      const avgConcurrency = executorRunTime / stageDurationMs;
      // jvmGCTime is a cross-task core-time sum (same shape as executorRunTime); dividing by the
      // stage's average concurrency converts it to an approximate wall-clock figure. Modeled, not exact.
      const wasteMs = jvmGCTime / avgConcurrency;
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', rawWaste);
    }
    case 'skew': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const p50 = stage.taskDurationP50 ?? 0;
      // computeSkewRatio's own metric labels (src/detectors.ts): 'P95/median' or 'max/median'.
      const usesP95Branch = finding.metric === 'P95/median';
      const wasteMs = Math.max(0, usesP95Branch ? (stage.taskDurationP95 ?? 0) - p50 : (stage.taskDurationMax ?? 0) - p50);
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'measured', { value: wasteMs, unit: 'ms' }, TAIL_CLAIM);
    }
    case 'straggler':
    case 'stageShape': {
      // Shared case for two finding types. straggler (no `rule` field) falls through to the max-P50
      // computation below; every stageShape rule returns early (not `break`, which would fall off
      // the switch and return undefined instead of null since the switch is the function's last statement).
      if (finding.type === 'stageShape') {
        if (finding.rule === 'lowParallelism') {
          const stage = stages.get(finding.stageId as number);
          if (!stage) return null;
          const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
          const idleCoreMs =
            Math.max(0, ((finding.totalCores as number | undefined) ?? 0) - (stage.taskCount ?? 0)) * stageDurationMs;
          // Real per-stage data (cores, task count, duration), no assumed constant.
          return costOnly('measured', { value: idleCoreMs, unit: 'coreMs' });
        }
        if (finding.rule === 'dataExplosion') {
          const stage = stages.get(finding.stageId as number);
          if (!stage) return null;
          const excessBytes = Math.max(0, (stage.outputBytes ?? 0) - (stage.inputBytes ?? 0));
          // Measured input/output byte counts, no assumed constant.
          return costOnly('measured', { value: excessBytes, unit: 'bytes' });
        }
        if (finding.rule === 'taskStageSkew') {
          const stage = stages.get(finding.stageId as number);
          if (!stage) return null;
          const totalCores = (finding.totalCores as number | undefined) ?? 0;
          const taskCount = stage.taskCount ?? 0;
          // Cores idle during the straggler's tail, at achieved concurrency (not full cluster
          // capacity, which is lowParallelism's territory): this rule's trigger forces the
          // occupancy-clipped estimate to zero on every firing, so it's resourceOnly, not a wall-clock claim.
          const idleCoreMs =
            Math.max(0, Math.min(totalCores, taskCount) - 1) *
            Math.max(0, (stage.taskDurationMax ?? 0) - (stage.taskDurationP50 ?? 0));
          return costOnly('measured', { value: idleCoreMs, unit: 'coreMs' });
        }
        return null;
      }
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = Math.max(0, (stage.taskDurationMax ?? 0) - (stage.taskDurationP50 ?? 0));
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'measured', { value: wasteMs, unit: 'ms' }, TAIL_CLAIM);
    }
    case 'slowHost': {
      // Three duration-based shapes, each carrying its absolute-ms figure under a different field
      // (`value` is always a ratio/share, never ms): the per-host mean branch (discriminated by
      // `metric`), the duration-share branch (`variant`), and the multiDim taskTime dimension. Every
      // byte-based multiDim dimension has no absolute figure today, so it stays informational.
      const absoluteMs =
        finding.metric === 'hostMeanRatio' || finding.variant === 'durationShare'
          ? (finding.hostMeanMs as number | undefined)
          : finding.variant === 'multiDim' && finding.dimension === 'taskTime'
            ? (finding.execMaxValue as number | undefined)
            : null;
      if (absoluteMs == null) {
        return costOnly('none'); // byte-based multiDim dims: no absolute figure today, no model applied
      }
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const wasteMs = Math.max(0, absoluteMs - (stage.taskDurationP50 ?? 0));
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'measured', { value: wasteMs, unit: 'ms' });
    }
    case 'duplicatePlanSubtree': {
      const stageIds = finding.stageIds as number[] | undefined;
      if (!stageIds || stageIds.length === 0) return null;
      // The detector reports subtreeOccurrences >= 2. Only repeats past the first are redundant:
      // computing the subtree once is real work, so waste is (occurrences-1)/occurrences of the stages' time.
      const occurrences = typeof finding.value === 'number' ? finding.value : 0;
      // Defensive only: minOccurrences guarantees occurrences >= 2 on real data; a malformed-value fallback.
      if (occurrences < 2) return costOnly('none');
      const redundantFraction = (occurrences - 1) / occurrences;
      const wasteMsByStage = new Map<number, number>();
      for (const id of stageIds) {
        const s = stages.get(id);
        if (s) {
          const durationMs = Math.max(0, (s.completedAt ?? 0) - (s.submittedAt ?? 0));
          wasteMsByStage.set(id, durationMs * redundantFraction);
        }
      }
      const totalWasteMs = [...wasteMsByStage.values()].reduce((sum, ms) => sum + ms, 0);
      const rawWaste: RawWasteFigure = { value: totalWasteMs, unit: 'ms' };
      const est = estimateMultiStage(stageIds, wasteMsByStage, stages as unknown as Map<number, OccupancyStage>, occupancy);
      if (!est) return costOnly('measured', rawWaste);
      return { basis: est.basis, wallClock: est.wallClock, estimateMethod: 'measured', rawWaste };
    }
    case 'shuffle': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const shuffleReadBytes = stage.shuffleReadBytes ?? 0;
      const wasteMs = (shuffleReadBytes / (SHUFFLE_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
      // The measured byte volume driving the modeled ms figure above.
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', { value: shuffleReadBytes, unit: 'bytes' });
    }
    case 'spill': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const diskBytesSpilled = stage.diskBytesSpilled ?? 0;
      const wasteMs = (diskBytesSpilled / (SPILL_IO_THROUGHPUT_BPS * stageIoParallelism(stage))) * 1000;
      // Surfaces the number the formula uses: the displayed metric is memoryBytesSpilled, but disk spill costs the I/O time.
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', { value: diskBytesSpilled, unit: 'bytes' });
    }
    case 'stageSlowness': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const stageDurationMs = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
      const wasteMs = Math.max(0, stageDurationMs - STAGE_SLOWNESS_THRESHOLD_MINUTES * 60000);
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', { value: wasteMs, unit: 'ms' });
    }
    case 'partitionSizing': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      let wasteMs = 0;
      if (finding.rule === 'maxPartitionTooBig') {
        wasteMs = ((stage.shuffleReadMax ?? 0) / SHUFFLE_THROUGHPUT_BPS) * 1000;
      } else if (finding.rule === 'shufflePartitionSkew') {
        const delta = Math.max(0, (stage.shuffleReadMax ?? 0) - (stage.shuffleReadP50 ?? 0));
        wasteMs = (delta / SHUFFLE_THROUGHPUT_BPS) * 1000;
      } else if (finding.rule === 'lowShuffleParallelism') {
        const targetTaskCount = Math.ceil((stage.shuffleReadBytes ?? 0) / IDEAL_BYTES_PER_PARTITION_TASK);
        const taskCount = stage.taskCount ?? 0;
        if (targetTaskCount > taskCount && taskCount > 0) {
          const stageDurationMs = Math.max(0, (stage.completedAt ?? 0) - (stage.submittedAt ?? 0));
          // Too few shuffle partitions means each task processes more than the ideal bytes,
          // serializing work more partitions would run concurrently: the waste is that serialized
          // work, not the scheduling cost of tasks you'd add (adding tasks incurs overhead, recovers
          // nothing). Model the achievable duration at target parallelism by scaling down proportionally.
          wasteMs = stageDurationMs * (1 - taskCount / targetTaskCount);
        }
      } else {
        return null;
      }
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', { value: wasteMs, unit: 'ms' });
    }
    case 'tinyTask': {
      if (finding.stageId == null) return null;
      const stage = stages.get(finding.stageId);
      if (!stage) return null;
      const taskCount = stage.taskCount ?? 0;
      const excessTaskCount = Math.max(0, taskCount - Math.round(taskCount / 10));
      const wasteMs = excessTaskCount * TASK_SCHEDULING_OVERHEAD_MS;
      return singleStageImpact(wasteMs, finding.stageId, stages, occupancy, 'modeled', { value: wasteMs, unit: 'ms' });
    }
    case 'smallFiles': {
      const wasteMs = ((finding.fileCount as number | undefined) ?? 0) * FILE_OPEN_OVERHEAD_MS;
      return stageMappableWasteOrCostOnly(wasteMs, finding.stageIds as number[] | undefined, stages, occupancy);
    }
    case 'overBroadcast': {
      // metric: 'broadcastBytes', value: <bytes>.
      const wasteMs = (((finding.value as number | undefined) ?? 0) / BROADCAST_BANDWIDTH_BPS) * 1000;
      return stageMappableWasteOrCostOnly(wasteMs, finding.stageIds as number[] | undefined, stages, occupancy);
    }
    case 'underBroadcast': {
      // metric: 'smallerSideBytes', value: <bytes of the smaller join side>.
      const wasteMs = (((finding.value as number | undefined) ?? 0) / BROADCAST_BANDWIDTH_BPS) * 1000;
      return stageMappableWasteOrCostOnly(wasteMs, finding.stageIds as number[] | undefined, stages, occupancy);
    }
    case 'memoryUtilization': {
      // The wasteModel variant reports metric: 'wastedMBSeconds', value: <MB-seconds>.
      if (finding.variant === 'wasteModel' && typeof finding.value === 'number') {
        return costOnly('measured', { value: finding.value, unit: 'mbSeconds' });
      }
      if (finding.variant === 'idleCores') {
        // Idle core-time priced as memory held but unused: the same MB-seconds unit as wasteModel, so comparable.
        const idleRateFraction = finding.idleRateFraction as number | undefined;
        const allocatedMB = finding.allocatedMB as number | undefined;
        const peakExecutors = finding.peakExecutors as number | undefined;
        const appDurationMs = finding.appDurationMs as number | undefined;
        if (idleRateFraction != null && allocatedMB != null && peakExecutors != null && appDurationMs != null) {
          const wastedMBSeconds = idleRateFraction * allocatedMB * peakExecutors * (appDurationMs / 1000);
          return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
        }
        return costOnly('modeled');
      }
      // Only the over-provisioned band is a waste; the near-capacity band is an OOM-risk signal with
      // no magnitude, and the dataUnavailable shape has no inputs: both stay informational.
      if (finding.variant === 'memoryBand' && finding.rule === 'heapOverProvisioned') {
        const allocatedBytes = finding.allocatedBytes as number | undefined;
        const heap = finding.heap as number | undefined;
        const appDurationMs = finding.appDurationMs as number | undefined;
        if (allocatedBytes != null && heap != null && appDurationMs != null) {
          const unusedMB = (allocatedBytes - heap) / (1024 * 1024);
          const wastedMBSeconds = unusedMB * (appDurationMs / 1000);
          return costOnly('modeled', { value: wastedMBSeconds, unit: 'mbSeconds' });
        }
      }
      return costOnly('modeled');
    }
    case 'utilization': {
      const fraction = finding.utilizationFraction as number | undefined;
      const appDurationMs = finding.appDurationMs as number | undefined;
      const totalCores = finding.totalCores as number | undefined;
      if (fraction == null || appDurationMs == null || totalCores == null) {
        return costOnly('measured');
      }
      const idleCoreHours = (1 - fraction) * appDurationMs * totalCores / 3.6e6;
      return costOnly('measured', { value: idleCoreHours, unit: 'coreHours' });
    }
    case 'coreLocality': {
      const nonLocal = (finding.nonLocalTaskCount as number | undefined) ?? 0;
      const coreMs = nonLocal * NETWORK_FETCH_PENALTY_MS;
      return costOnly('modeled', { value: coreMs, unit: 'coreMs' });
    }
    case 'autoscalingChurn': {
      const shortLived = (finding.shortLivedExecutorCount as number | undefined) ?? 0;
      const executorHours = (shortLived * EXECUTOR_STARTUP_OVERHEAD_MS) / 3.6e6;
      return costOnly('modeled', { value: executorHours, unit: 'coreHours' });
    }
    case 'configAudit': {
      return costOnly('none'); // purely informational: no waste model applied
    }
    case 'jobFailureRate': {
      const failedJobs = (finding.failedJobs as number | undefined) ?? 0;
      const avgJobDurationMs = (finding.avgJobDurationMs as number | undefined) ?? 0;
      const coreHoursIsh = (failedJobs * avgJobDurationMs) / 3.6e6;
      return costOnly('modeled', { value: coreHoursIsh, unit: 'coreHours' });
    }
    case 'cachingOpportunity': {
      const totalReadBytes = (finding.totalReadBytes as number | undefined) ?? 0;
      const wasteMs = (totalReadBytes / RE_READ_THROUGHPUT_BPS) * 1000;
      return costOnly('modeled', { value: wasteMs, unit: 'ms' });
    }
    case 'cacheUtilization': {
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
      return costOnly('modeled', { value: wasteMs, unit: 'ms' });
    }
    case 'stageFailed':
    case 'failures':
    case 'incompleteRun': {
      return costOnly('none'); // purely informational: no waste model applied
    }
    default:
      return null;
  }
}

export function estimateImpact(findings: Finding[], stages: Map<number, Stage>, totalCores = 0): Finding[] {
  const occupancy = computeOccupancy(stages as unknown as Map<number, OccupancyStage>, totalCores);
  for (const f of findings) {
    const estimate = computeEstimateForFinding(f, stages, occupancy);
    if (estimate) f.impactEstimate = estimate;
  }
  return findings;
}
