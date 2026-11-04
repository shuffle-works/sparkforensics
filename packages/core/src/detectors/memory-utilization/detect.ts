import { computeAllocation } from '../../allocation.ts';
import { computeEfficiencyModel } from '../../efficiency-model.ts';
import { runTiming } from '../../run-timing.ts';
import { executorHeapPeaks } from '../../executor-peaks.ts';
import { costOnly } from '../../impact-model.ts';
import { decreaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { loggedAs } from '../conf.ts';
import { memoryWasteConfidence } from '../confidence.ts';
import { defineAppDetector } from '../define.ts';
import { idleCapacityFix, switchFix } from '../fixes.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

// Four shapes: idle core-time, the executor heap band (over-provisioned, or the caveat for a log
// with no executor metrics) and the allocated-vs-used memory-time waste model.
export interface MemoryIdleCoresEvidence {
  variant: 'idleCores';
}

export interface MemoryIdleCoresFinding extends NumericFinding<'memoryUtilization'>, MemoryIdleCoresEvidence {
  // Impact-estimator inputs: the unrounded idle rate and the run's allocated memory-time.
  idleRateFraction: number;
  allocatedMBSeconds: number | null;
}

// The memoryBand caveat for a log with no executor metrics.
export interface MemoryBandUnavailableEvidence {
  variant: 'memoryBand';
  rule?: undefined;
  dataUnavailable: true;
}

export interface MemoryBandUnavailableFinding extends NumericFinding<'memoryUtilization'>, MemoryBandUnavailableEvidence {}

export interface MemoryHeapOverProvisionedEvidence {
  variant: 'memoryBand';
  rule: 'heapOverProvisioned';
  // The executor with the highest sampled heap peak.
  executorId: string;
  // That peak heap, bytes (a lower bound: Spark samples at heartbeat).
  heap: number;
  dataUnavailable?: undefined;
}

export interface MemoryHeapOverProvisionedFinding extends NumericFinding<'memoryUtilization'>, MemoryHeapOverProvisionedEvidence {
  // Impact-estimator inputs behind the rounded ratio: the allocation, the executors with a
  // measured peak, and the seconds the run's executors were alive.
  allocatedBytes: number;
  executorCount: number;
  executorSeconds: number;
}

export interface MemoryWasteModelEvidence {
  variant: 'wasteModel';
}

export interface MemoryWasteModelFinding extends NumericFinding<'memoryUtilization'>, MemoryWasteModelEvidence {
  // Impact-estimator input: the run's allocated memory-time.
  allocatedMBSeconds: number;
}

export type MemoryUtilizationEvidence =
  | MemoryIdleCoresEvidence | MemoryBandUnavailableEvidence | MemoryHeapOverProvisionedEvidence | MemoryWasteModelEvidence;

export type MemoryUtilizationFinding =
  | MemoryIdleCoresFinding | MemoryBandUnavailableFinding | MemoryHeapOverProvisionedFinding | MemoryWasteModelFinding;

const LOG_STAGE_EXECUTOR_METRICS_KEY = 'spark.eventLog.logStageExecutorMetrics';

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

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  memoryUtilization: { finding: MemoryIdleCoresFinding | MemoryBandUnavailableFinding | MemoryHeapOverProvisionedFinding | MemoryWasteModelFinding; evidence: MemoryUtilizationEvidence };
}

export const detectors = [memoryUtilizationDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  memoryUtilization: ['variant', 'rule', 'executorId', 'heap', 'dataUnavailable'],
} as const satisfies {
  memoryUtilization: readonly AllKeys<MemoryUtilizationEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  memoryUtilization: ['executorId', 'variant'],
} as const satisfies {
  memoryUtilization: readonly (DiscriminatorSlot & AllKeys<FindingOf<'memoryUtilization'>>)[];
};
