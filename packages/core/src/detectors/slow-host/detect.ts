import { medianOfSorted } from '../../median.ts';
import { costOnly, singleStageImpact } from '../../impact-model.ts';
import { SLOW_HOST_DIMENSION_LABEL, SLOW_HOST_DIMENSION_PER_TASK } from '../../finding-generic-recommendation.ts';
import type { Finding, ImpactEstimate } from '../../types.ts';
import type { FindingOf, AllKeys } from '../../finding-types.ts';
import { loggedAs } from '../conf.ts';
import { defineStageDetector } from '../define.ts';
import { switchFix } from '../fixes.ts';
import { stageBelowRuntimeFloor } from '../runtime-floor.ts';
import type { DetectorExecutorStat } from '../types.ts';
import { MB } from '../units.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';
import { speculationRule } from '../speculation.ts';

// Three shapes: a slow host by mean task time (no `variant`, so the key is absent at runtime), a host
// doing most of the stage's task time ('durationShare'), and an executor deviating on one dimension
// ('multiDim').
interface SlowHostByHostEvidence {
  host: string;
  hostTaskShare: number;
  // The host's mean task duration, ms: `value` is a ratio or share.
  hostMeanMs: number;
}

export interface SlowHostMeanTimeEvidence extends SlowHostByHostEvidence {
  variant?: undefined;
}

export interface SlowHostDurationShareEvidence extends SlowHostByHostEvidence {
  variant: 'durationShare';
}

export interface SlowHostMultiDimEvidence {
  variant: 'multiDim';
  dimension: 'taskTime' | 'inputBytes' | 'shuffleBytes' | 'storageMemory';
  executorId: string;
  // The deviating executor's compared value in `dimension`'s unit: ms per task for taskTime, bytes
  // per task for inputBytes and shuffleBytes (so executors that lived for different spans compare),
  // bytes for storageMemory. `medianValue` is the median of the same value over `executorCount` executors.
  execMaxValue: number;
  medianValue: number;
  // How many executors the deviating one was picked from. The largest of N samples reaches a high
  // ratio by chance more often as N grows.
  executorCount: number;
  // taskTime only: the stage's task count.
  taskCount?: number;
}

export type SlowHostEvidence = SlowHostMeanTimeEvidence | SlowHostDurationShareEvidence | SlowHostMultiDimEvidence;

export interface SlowHostMeanTimeFinding extends NumericFinding<'slowHost'>, SlowHostMeanTimeEvidence {}

export interface SlowHostDurationShareFinding extends NumericFinding<'slowHost'>, SlowHostDurationShareEvidence {}

export interface SlowHostMultiDimFinding extends NumericFinding<'slowHost'>, SlowHostMultiDimEvidence {}

export type SlowHostFinding = SlowHostMeanTimeFinding | SlowHostDurationShareFinding | SlowHostMultiDimFinding;

// `value` is what executors are compared on; `total` is the executor's absolute magnitude when
// `value` is a rate, for the absolute-magnitude floor.
interface DimensionSample { key: string; value: number; total?: number }

// Max/median deviation ratio over a list of {key, value}; returns the
// exceeding entry's key + ratio, or null when < 3 samples or median 0. `qualifies` narrows the
// entries the maximum is taken from (the median still covers all of them).
function maxMedianRatio(
  samples: DimensionSample[],
  qualifies: (sample: DimensionSample) => boolean = () => true,
): { key: string; ratio: number; value: number; median: number; total: number } | null {
  if (samples.length < 3) return null;
  const vals = samples.map(s => s.value).sort((a, b) => a - b);
  const median = medianOfSorted(vals);
  if (median <= 0) return null;
  const pool = samples.filter(qualifies);
  if (pool.length === 0) return null;
  const top = pool.reduce((a, b) => (b.value > a.value ? b : a));
  return { key: top.key, ratio: top.value / median, value: top.value, median, total: top.total ?? top.value };
}

// z a lone executor's mean must clear to stand out from `executors` chance draws at a family-wise
// false-flag rate of `alpha`. A normal tail obeys P(Z > z) <= exp(-z^2 / 2) / 2, so a
// Bonferroni share of alpha / executors gives z = sqrt(2 ln(executors / (2 alpha))): the cutoff
// grows with the number of executors the largest mean was picked from.
function chanceOutlierZ(executors: number, alpha: number): number {
  return Math.sqrt(2 * Math.log(executors / (2 * alpha)));
}

// How far each executor's tasks sit above the stage's median executor, in standard errors, on the
// log scale of one per-task quantity: (executor mean - median of executor means) / (stage task sd /
// sqrt(executor tasks)). The stage sd is rebuilt from the per-executor count, log sum and M2:
// within-executor squared deviations plus each executor mean's distance from the grand mean. null
// when the stage has under two tasks, no spread, or any executor lacks finite log stats, so an
// unknown spread never flags an executor.
function executorLogZ(
  execs: DetectorExecutorStat[],
  logSum: (e: DetectorExecutorStat) => number | undefined,
  logM2: (e: DetectorExecutorStat) => number | undefined,
): Map<string, number> | null {
  const active = execs.filter(e => e.taskCount > 0);
  let tasks = 0, logTotal = 0;
  for (const e of active) {
    if (!Number.isFinite(logSum(e)) || !Number.isFinite(logM2(e))) return null;
    tasks += e.taskCount;
    logTotal += logSum(e) as number;
  }
  if (tasks < 2) return null;
  const grandMean = logTotal / tasks;
  let squares = 0;
  const means = active.map(e => (logSum(e) as number) / e.taskCount);
  active.forEach((e, i) => { squares += (logM2(e) as number) + e.taskCount * (means[i] - grandMean) ** 2; });
  const sd = Math.sqrt(squares / (tasks - 1));
  if (!(sd > 0) || !Number.isFinite(sd)) return null;
  const median = medianOfSorted([...means].sort((a, b) => a - b));
  return new Map(active.map((e, i) => [e.executorId, (means[i] - median) / (sd / Math.sqrt(e.taskCount))]));
}

// slowHost's taskTime dimension picks the largest of N per-executor mean task times: the more
// executors, the likelier the largest reaches a given ratio to the median by chance alone, whatever
// the hardware. The band comes from the modeled saving, so the finding states how weak the signal is.
// No `host` here: it is one of slowHost's id discriminators, so setting it would change the id.
function executorTaskTimeCaveat(
  executorId: string, ratio: number, executorCount: number, taskCount: number,
): Pick<SlowHostMultiDimFinding, 'confidence' | 'validationRequired' | 'taskCount'> {
  return {
    confidence: 'low',
    validationRequired:
      `One of ${executorCount} executors: the largest of ${executorCount} per-executor mean task times reaches ${Math.round(ratio * 10) / 10}x the median by chance ` +
      `when task durations vary widely or each executor ran few tasks (${taskCount} tasks over ${executorCount} executors here). ` +
      `Compare per-task times on executor ${executorId} in the Spark UI before acting.`,
    taskCount,
  };
}

export const slowHostDetector = defineStageDetector({
  type: 'slowHost', order: 60, bandPolicy: 'derived', fixEffort: 'config', version: 3,
  emits: ['slowHost'],
  docAnchor: '#bottleneck-slow-host',
  thresholds: {
    minHosts: 3, minTasks: 15, ratioWarn: 2.0, minShare: 0.20, shareWarn: 0.75, taskShareWarn: 0.50, ratioTiers: [1.33, 1.78, 3.16, 10],
    // Absolute-magnitude floors (mirrors computeSpillMagnitude's ratio+floor pattern): on short
    // stages, sub-second/sub-64MB host differences produce huge noise ratios. 1s is above
    // per-task jitter but below genuine slow-host stages; 64MB mirrors the spill disk-skew floor.
    floorMs: 1000, floorBytes: 64 * MB,
    // stageFloorPct: the tiered detectors' 0.5% runtime floor. On a stage shorter than this share
    // of the run a slow host can't cost that much: duration findings are clipped to the stage
    // and would grade info, so the stage is skipped.
    stageFloorPct: 0.005,
    // outlierAlpha: the nominal chance a stage of alike tasks gets any executor flagged on task
    // time, input bytes per task or shuffle bytes per task. The largest of many executors always
    // tops the median, so an executor is flagged only when its mean sits further above the median
    // than the stage's own task spread and its task count allow (chanceOutlierZ), more strictly the
    // more executors there are.
    // The normal-tail bound behind that cutoff is loose: simulated alike stages flag well under it.
    outlierAlpha: 0.005,
  },
  detect(stage, ctx, thresholds): Finding[] | null {
    const hosts = stage.hostStats ?? [];
    const execs0 = stage.executorStats ?? [];
    if ((hosts.length < thresholds.minHosts && execs0.length < thresholds.minHosts) || stage.taskCount < thresholds.minTasks) return null;
    if (stageBelowRuntimeFloor(stage, ctx, thresholds.stageFloorPct)) return null;
    const out: Finding[] = [];
    const rule = speculationRule(ctx.app);
    const speculation = switchFix(loggedAs(ctx.app, 'spark.speculation', true), 'spark.speculation', true,
      `check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically${rule ? ` (with this run's settings, ${rule})` : ''}`,
      `check what it was running; speculation is already on, so a lagging task there is already relaunched${rule ? ` (with this run's settings, ${rule})` : ''}`);
    if (hosts.length >= thresholds.minHosts) {
      const means = hosts.map(h => ({ host: h.host, taskCount: h.taskCount, mean: h.totalDuration / h.taskCount }));
      const sorted = [...means].map(h => h.mean).sort((a, b) => a - b);
      const overallMedian = medianOfSorted(sorted);
      if (overallMedian > 0) {
        for (const h of means) {
          const ratio = h.mean / overallMedian;
          const share = h.taskCount / stage.taskCount;
          if (ratio < thresholds.ratioWarn || share < thresholds.minShare || h.mean < thresholds.floorMs) continue;
          out.push({
            type: 'slowHost', stageId: stage.id,
            impactBand: 'warning',
            metric: 'hostMeanRatio', value: Math.round(ratio * 10) / 10,
            // `value` is a ratio; the estimator needs the absolute per-host mean.
            hostMeanMs: h.mean,
            host: h.host, hostTaskShare: Math.round(share * 100) / 100,
            recommendation: `${h.host} may just hold data locality for its tasks or carry one heavy stage, not necessarily a hardware fault: ${speculation.text}.`,
            remediation: speculation.remediation,
          });
        }
      }
      const totalDuration = hosts.reduce((s, h) => s + h.totalDuration, 0);
      if (totalDuration > 0) {
        for (const h of hosts) {
          const durationShare = h.totalDuration / totalDuration;
          const taskShare = h.taskCount / stage.taskCount;
          if (durationShare >= thresholds.shareWarn && taskShare >= thresholds.taskShareWarn) {
            out.push({
              type: 'slowHost', stageId: stage.id, impactBand: 'warning',
              variant: 'durationShare',
              metric: 'hostDurationShare', value: Math.round(durationShare * 100) / 100,
              // `value` is a 0-1 share; the estimator needs the absolute per-host mean.
              hostMeanMs: h.totalDuration / h.taskCount,
              host: h.host, hostTaskShare: Math.round(taskShare * 100) / 100,
              recommendation: `${h.host} is doing ${Math.round(durationShare * 100)}% of this stage's total task time: check for data locality or partition assignment skewing work onto one node.`,
            });
          }
        }
      }
    }
    const execs = stage.executorStats ?? [];
    const floorMs = thresholds.floorMs, floorBytes = thresholds.floorBytes;
    const taskTimeSamples = execs.filter(e => e.taskCount > 0).map(e => ({ key: e.executorId, value: e.totalDuration / e.taskCount }));
    const outlierZ = chanceOutlierZ(taskTimeSamples.length, thresholds.outlierAlpha);
    // Only an executor the stage's own spread can't explain: with no known spread, none.
    const beyondChance = (zs: Map<string, number> | null) => (sample: DimensionSample) => (zs?.get(sample.key) ?? -Infinity) >= outlierZ;
    // Spark's per-executor stage summary has no lifetime, so an executor's byte total grows with how
    // long it lived (dynamic allocation, executor loss). Bytes per task does not.
    const bytesPerTask = (bytes: (e: DetectorExecutorStat) => number): DimensionSample[] =>
      execs.filter(e => e.taskCount > 0).map(e => ({ key: e.executorId, value: bytes(e) / e.taskCount, total: bytes(e) }));
    const dims: { dimension: SlowHostMultiDimFinding['dimension']; floor: number; samples: DimensionSample[]; qualifies?: (sample: DimensionSample) => boolean }[] = [
      {
        dimension: 'taskTime', floor: floorMs, samples: taskTimeSamples,
        qualifies: beyondChance(executorLogZ(execs, e => e.logDurationSum, e => e.logDurationM2)),
      },
      {
        dimension: 'inputBytes', floor: floorBytes, samples: bytesPerTask(e => e.inputBytes ?? 0),
        qualifies: beyondChance(executorLogZ(execs, e => e.logInputBytesSum, e => e.logInputBytesM2)),
      },
      {
        dimension: 'shuffleBytes', floor: floorBytes, samples: bytesPerTask(e => (e.shuffleReadBytes ?? 0) + (e.shuffleWriteBytes ?? 0)),
        qualifies: beyondChance(executorLogZ(execs, e => e.logShuffleBytesSum, e => e.logShuffleBytesM2)),
      },
    ];
    // Storage-memory dimension: best-effort, only when executorMetrics present.
    const em = stage.executorMetrics instanceof Map ? stage.executorMetrics : null;
    if (em && em.size >= 3) {
      dims.push({ dimension: 'storageMemory', floor: floorBytes, samples: [...em.entries()].map(([id, m]) => ({ key: id, value: (m.onHeapStorageMemory ?? 0) + (m.offHeapStorageMemory ?? 0) })) });
    }
    for (const d of dims) {
      const r = maxMedianRatio(d.samples, d.qualifies);
      if (!r || r.total < d.floor) continue; // absolute-magnitude floor: same ratio+floor shape as computeSpillMagnitude
      if (r.ratio < thresholds.ratioTiers[0]) continue;
      // No dimension has a cost estimate behind its ratio, so the band is `info` (see threshold-tables.md).
      out.push({
        type: 'slowHost', stageId: stage.id, impactBand: 'info',
        variant: 'multiDim', dimension: d.dimension,
        metric: 'execMaxMedianRatio', value: Math.round(r.ratio * 10) / 10,
        // `value` is a ratio of `execMaxValue` to `medianValue`, in the dimension's own unit.
        execMaxValue: r.value, medianValue: r.median, executorCount: d.samples.length,
        executorId: r.key,
        ...(d.dimension === 'taskTime' ? executorTaskTimeCaveat(r.key, r.ratio, d.samples.length, stage.taskCount) : {}),
        recommendation: `Executor ${r.key}'s ${SLOW_HOST_DIMENSION_LABEL[d.dimension]}${SLOW_HOST_DIMENSION_PER_TASK[d.dimension]} is ${Math.round(r.ratio * 10) / 10}× the median: ${SLOW_HOST_DIMENSION_PER_TASK[d.dimension] ? 'its tasks got larger partitions than the rest (data skew); investigate uneven partition assignment.' : 'investigate uneven partition assignment or a degraded executor.'}`,
      });
    }
    return out;
  },
  estimate(finding, ctx): ImpactEstimate | null {
    // Three duration-based shapes, each carrying its absolute-ms figure under a different field
    // (`value` is always a ratio/share, never ms): the per-host mean branch (discriminated by
    // `metric`), the duration-share branch (`variant`), and the multiDim taskTime dimension. Every
    // byte-based multiDim dimension has no absolute figure today, so it stays informational.
    const absoluteMs =
      finding.variant === 'multiDim'
        ? (finding.dimension === 'taskTime' ? finding.execMaxValue : null)
        : (finding.metric === 'hostMeanRatio' || finding.variant === 'durationShare' ? finding.hostMeanMs : null);
    if (absoluteMs == null) {
      return costOnly('none'); // byte-based multiDim dims: no absolute figure today, no model applied
    }
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const wasteMs = Math.max(0, absoluteMs - (stage.taskDurationP50 ?? 0));
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  slowHost: { finding: SlowHostMeanTimeFinding | SlowHostDurationShareFinding | SlowHostMultiDimFinding; evidence: SlowHostEvidence };
}

export declare const emits: Emits;

export const detectors = [slowHostDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  slowHost: ['variant', 'host', 'hostTaskShare', 'hostMeanMs', 'dimension', 'executorId', 'execMaxValue', 'medianValue', 'executorCount', 'taskCount'],
} as const satisfies {
  slowHost: readonly AllKeys<SlowHostEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  slowHost: ['host', 'executorId', 'variant', 'dimension'],
} as const satisfies {
  slowHost: readonly (DiscriminatorSlot & AllKeys<FindingOf<'slowHost'>>)[];
};
