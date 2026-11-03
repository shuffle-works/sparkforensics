import { IMPACT_BAND_ORDER } from '../impact-band-order.ts';
import { medianOfSorted } from '../median.ts';
import { shareLabel, type MetricName } from '../finding-presentation.ts';
import { STRAGGLER_FACTOR } from '../stage-quantiles.ts';
import { IMPACT_FLOOR_PCT_WARN, IMPACT_FLOOR_PCT_CRIT, appDurationMs } from '../impact-band.ts';
import { costOnly, singleStageImpact } from '../impact-model.ts';
import { SLOW_HOST_DIMENSION_LABEL } from '../finding-generic-recommendation.ts';
import { increaseConf } from '../remediation.ts';
import type { Finding, ImpactEstimate } from '../types.ts';
import type { FindingOf, Remediation, SlowHostMultiDimFinding } from '../finding-types.ts';
import { effectiveConf, loggedAs } from './conf.ts';
import { skewConfidence, speculationWasteConfidence, stragglerConfidence } from './confidence.ts';
import { defineStageDetector } from './define.ts';
import { switchFix } from './fixes.ts';
import { meetsRuntimeFloor, stageBelowRuntimeFloor } from './runtime-floor.ts';
import { skewFix } from './skew-fix.ts';
import { skewGate, skewTailClaim, stragglerTailClaim, tailClaimFloorMs, tailClaimImpact, tailVerdict, type TailVerdict } from './tail.ts';
import type { DetectorApp, DetectorCtx, DetectorExecutorStat, DetectorStage } from './types.ts';
import { MB } from './units.ts';

// Max/median deviation ratio over a list of {key, value}; returns the
// exceeding entry's key + ratio, or null when < 3 samples or median 0. `qualifies` narrows the
// entries the maximum is taken from (the median still covers all of them).
function maxMedianRatio(
  samples: { key: string; value: number }[],
  qualifies: (sample: { key: string; value: number }) => boolean = () => true,
): { key: string; ratio: number; value: number } | null {
  if (samples.length < 3) return null;
  const vals = samples.map(s => s.value).sort((a, b) => a - b);
  const median = medianOfSorted(vals);
  if (median <= 0) return null;
  const pool = samples.filter(qualifies);
  if (pool.length === 0) return null;
  const top = pool.reduce((a, b) => (b.value > a.value ? b : a));
  return { key: top.key, ratio: top.value / median, value: top.value };
}

// z a lone executor's mean must clear to stand out from `executors` chance draws at a family-wise
// false-flag rate of `alpha`. A normal tail obeys P(Z > z) <= exp(-z^2 / 2) / 2, so a
// Bonferroni share of alpha / executors gives z = sqrt(2 ln(executors / (2 alpha))): the cutoff
// grows with the number of executors the largest mean was picked from.
function chanceOutlierZ(executors: number, alpha: number): number {
  return Math.sqrt(2 * Math.log(executors / (2 * alpha)));
}

// How far each executor's task durations sit above the stage's median executor, in standard errors,
// on the log scale: (executor mean - median of executor means) / (stage task sd / sqrt(executor
// tasks)). The stage sd is rebuilt from the per-executor count, log sum and M2: within-executor
// squared deviations plus each executor mean's distance from the grand mean. null when the stage
// has under two tasks, no spread, or any executor lacks finite log stats, so an unknown spread
// never flags an executor.
function executorDurationZ(execs: DetectorExecutorStat[]): Map<string, number> | null {
  const active = execs.filter(e => e.taskCount > 0);
  let tasks = 0, logTotal = 0;
  for (const e of active) {
    if (!Number.isFinite(e.logDurationSum) || !Number.isFinite(e.logDurationM2)) return null;
    tasks += e.taskCount;
    logTotal += e.logDurationSum as number;
  }
  if (tasks < 2) return null;
  const grandMean = logTotal / tasks;
  let squares = 0;
  const means = active.map(e => (e.logDurationSum as number) / e.taskCount);
  active.forEach((e, i) => { squares += (e.logDurationM2 as number) + e.taskCount * (means[i] - grandMean) ** 2; });
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
): Pick<SlowHostMultiDimFinding, 'confidence' | 'validationRequired' | 'executorCount' | 'taskCount'> {
  return {
    confidence: 'low',
    validationRequired:
      `One of ${executorCount} executors: the largest of ${executorCount} per-executor mean task times reaches ${Math.round(ratio * 10) / 10}x the median by chance ` +
      `when task durations vary widely or each executor ran few tasks (${taskCount} tasks over ${executorCount} executors here). ` +
      `Compare per-task times on executor ${executorId} in the Spark UI before acting.`,
    executorCount, taskCount,
  };
}

// When Spark relaunches a slow task under the run's effective speculation settings: once the
// quantile of the stage's tasks has finished, a task running over the multiplier times the median
// of the finished ones gets a copy (TaskSetManager.checkSpeculatableTasks). Null when either
// setting is neither logged nor a default the run's Spark version fixes.
function speculationRule(app: DetectorApp | null): string | null {
  const multiplier = Number.parseFloat(effectiveConf(app, 'spark.speculation.multiplier') ?? '');
  const quantile = Number.parseFloat(effectiveConf(app, 'spark.speculation.quantile') ?? '');
  if (!Number.isFinite(multiplier) || !Number.isFinite(quantile)) return null;
  return `a task running over ${multiplier}x the median is relaunched once ${Math.round(quantile * 100)}% of the stage's tasks have finished`;
}

function speculationRuleNote(app: DetectorApp | null): string {
  const rule = speculationRule(app);
  return rule == null ? '' : ` (with this run's settings, ${rule})`;
}

// A tail reading at least this many times the median task's data is not described as reading no more.
const MORE_DATA_RATIO = 2;

// straggler's own gate: tasks over 4x P50 are more than `shareWarn` of the stage (`shareWarnAtFloor`
// when the occupancy-clipped tail clears the runtime floor), or a speculative task ran. Null when it
// does not hold, else what the finding reports.
function stragglerGate(stage: DetectorStage, ctx: DetectorCtx, thresholds: {
  minTasks: number; shareWarn: number; shareWarnAtFloor: number; warnPct: number; critPct: number;
  floorPctWarn: number; floorPctCrit: number;
}): { useSpeculativeMetric: boolean; value: number; detail: string; confidence: 'low' | 'medium' | 'high' } | null {
  if (stage.taskCount < thresholds.minTasks) return null;
  const runMs = appDurationMs(ctx.app);
  if (stageBelowRuntimeFloor(stage, ctx, thresholds.floorPctWarn)) return null;
  const stragglerShare = (stage.stragglerCount ?? 0) / stage.taskCount;
  const useSpeculative = (stage.speculativeTasks ?? 0) > 0;
  if (!useSpeculative && stragglerShare <= thresholds.shareWarnAtFloor) return null;
  const speculativeShare = useSpeculative ? stage.speculativeTasks / stage.taskCount : 0;
  // The claim estimate() reports as savings: a high straggler/speculative share on a stage
  // whose tasks barely vary models near-zero savings, so it must not outrank 'info'.
  const floorWasteMs = tailClaimFloorMs(stragglerTailClaim(stage), stage.id, ctx);
  const meetsWarnFloor = meetsRuntimeFloor(floorWasteMs, runMs, thresholds.floorPctWarn);
  const meetsCritFloor = meetsRuntimeFloor(floorWasteMs, runMs, thresholds.floorPctCrit);
  // The lower gate needs positive evidence the tail matters: meetsRuntimeFloor passes by
  // default when the app's duration is unknown (an incomplete run), which isn't that.
  const stragglerShareFires = stragglerShare > thresholds.shareWarn
    || (stragglerShare > thresholds.shareWarnAtFloor && runMs != null && meetsWarnFloor);
  if (!useSpeculative && !stragglerShareFires) return null;
  const speculativeTier = speculativeShare >= thresholds.critPct && meetsCritFloor ? 'critical'
                         : speculativeShare >= thresholds.warnPct && meetsWarnFloor ? 'warning' : 'info';
  // A straggler share has only a warning tier (threshold-tables.md, Straggler row).
  const stragglerTier = stragglerShareFires && meetsWarnFloor ? 'warning' : 'info';
  // Report whichever signal actually drove the finding, not just whether speculation was on:
  // a high stragglerShare with few speculative retries must not be reported as a low-value
  // speculativeTasks count. Ties keep the speculative-driven default.
  const useSpeculativeMetric = useSpeculative && !(IMPACT_BAND_ORDER[stragglerTier] < IMPACT_BAND_ORDER[speculativeTier]);
  const value = useSpeculativeMetric ? stage.speculativeTasks : Math.round(stragglerShare * 100);
  return {
    useSpeculativeMetric, value,
    detail: useSpeculativeMetric
      ? `${value} speculative attempt${value === 1 ? '' : 's'} discarded${speculationRuleNote(ctx.app)}`
      : `${value}% of tasks ran over ${STRAGGLER_FACTOR}× the median`,
    confidence: useSpeculativeMetric
      ? stragglerConfidence(speculativeShare, thresholds.warnPct, thresholds.critPct)
      : stragglerConfidence(stragglerShare, thresholds.shareWarn, thresholds.critPct),
  };
}

// The straggler finding's evidence, recommendation and fix for the tail's cause. Without a measured
// cause there is nothing to fix yet, only the causes to check.
function stragglerAdvice(stage: DetectorStage, ctx: DetectorCtx, tail: TailVerdict, detail: string): {
  evidence: Pick<FindingOf<'straggler'>, 'origin' | 'aqeSkew' | 'cause' | 'causeSharePct' | 'host' | 'hostTasks' | 'cpuPct'>;
  recommendation: string;
  remediation: Remediation[] | undefined;
} {
  const a = tail.attribution;
  const cpuPct = a?.cpuPct != null ? Math.round(a.cpuPct) : undefined;
  const evidence = { cause: tail.cause, ...(tail.cause === 'unattributed' ? {} : { causeSharePct: tail.sharePct }), ...(cpuPct !== undefined ? { cpuPct } : {}) };
  const share = `${tail.sharePct}% of the slow tasks' extra time`;
  switch (tail.cause) {
    case 'data': {
      // skew reports a tail its gate admits; this is one only the straggler gate does.
      const fix = skewFix(stage, ctx, false, tail);
      const ratio = a?.dataRatio != null ? Math.round(a.dataRatio * 10) / 10 : null;
      return {
        evidence: { ...evidence, origin: fix.origin, aqeSkew: fix.aqeSkew }, remediation: fix.remediation,
        recommendation: `${detail}: data volume accounts for ${share} (${ratio !== null ? `the slow tasks read a median ${ratio}× the data of the median task` : 'the median task read almost nothing'}): ${fix.text}.`,
      };
    }
    case 'gc':
      return {
        evidence, remediation: [increaseConf('spark.executor.memory')],
        recommendation: `${detail}: GC accounts for ${share}: reduce object creation, use primitive types, avoid UDFs, increase executor memory.`,
      };
    case 'fetchWait':
      return {
        evidence, remediation: undefined,
        recommendation: `${detail}: waiting on shuffle fetches accounts for ${share}: look for a slow or overloaded node serving shuffle blocks, executors lost mid-stage, or reducers fetching many small blocks.`,
      };
    case 'host': {
      const speculation = switchFix(loggedAs(ctx.app, 'spark.speculation', true), 'spark.speculation', true,
        'check what it was running, and consider enabling spark.speculation to relaunch a lagging task automatically',
        'check what it was running; speculation is already on, so a lagging task there is already relaunched');
      return {
        evidence: { ...evidence, host: a!.host!, hostTasks: a!.hostTasks }, remediation: speculation.remediation,
        recommendation: `${detail}: ${a!.hostTasks} of the ${a!.tasks} slow tasks ran on ${a!.host}, which accounts for ${share}: ${speculation.text}.`,
      };
    }
    case 'unexplained': {
      const cpu = cpuPct === undefined ? '' : cpuPct < 50
        ? ` They used ${cpuPct}% of their run time on CPU, so they mostly waited (on storage, a remote service or a lock).`
        : ` They used ${cpuPct}% of their run time on CPU, so the work itself is slow.`;
      // A tail that read clearly more data is not "no more data" even when run time did not scale
      // with it; where data is the largest share anyway, the data advice stays.
      const dataRatio = a?.dataRatio ?? 0;
      if (a != null && dataRatio >= MORE_DATA_RATIO) {
        const rounded = Math.round(dataRatio * 10) / 10;
        const dataShare = Math.round((a.dataMs / a.excessMs) * 100);
        const dataLargest = a.dataMs >= a.excessMs - a.dataMs - a.gcMs - a.fetchWaitMs - a.hostMs;
        const lead = `${detail}: the slow tasks read a median ${rounded}× the data of the median task, and data volume accounts for ${dataShare}% of their extra time`;
        if (dataLargest) {
          const fix = skewFix(stage, ctx, false, tail);
          return {
            evidence: { ...evidence, origin: fix.origin, aqeSkew: fix.aqeSkew }, remediation: fix.remediation,
            recommendation: `${lead}, more than anything else the log attributes (not a majority): ${fix.text}.`,
          };
        }
        return {
          evidence, remediation: undefined,
          recommendation: `${lead}, so run time did not scale with it, and GC, shuffle fetch wait and one slow host do not account for the rest.${cpu} Look at per-record cost (UDFs, regular expressions, a call out per row) as well as the data they read.`,
        };
      }
      return {
        evidence, remediation: undefined,
        recommendation: `${detail}: the slow tasks read no more data than the median task, and GC, shuffle fetch wait and one slow host do not account for their time.${cpu} Look at per-record cost (UDFs, regular expressions, a call out per row).`,
      };
    }
    default:
      return {
        evidence, remediation: undefined,
        recommendation: `${detail}: nothing in the log attributes the slow tasks to data volume, GC, shuffle fetch wait or one host, so check their input sizes, GC time and hosts before choosing a fix.`,
      };
  }
}

export const skewDetector = defineStageDetector({
  type: 'skew', order: 30, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['skew'],
  docAnchor: '#bottleneck-skew',
  // dataShareMin: the share of the slow tasks' extra time that run time proportional to their data
  // volume must account for before the tail is data skew; straggler judges a tail with it too.
  thresholds: { ratioWarn: 3, minTasksForP95: 20, dataShareMin: 0.5, floorPctWarn: IMPACT_FLOOR_PCT_WARN },
  detect(stage, ctx, thresholds): Finding | null {
    const gate = skewGate(stage, ctx, thresholds.ratioWarn, thresholds.minTasksForP95, thresholds.floorPctWarn);
    if (gate === null) return null;
    const { ratio, metric } = gate;
    // A tail data does not explain, or one with no measured cause, is not skew: straggler reports
    // it, with the cause (it re-runs this same gate, see skewGate).
    const tail = tailVerdict(stage, thresholds.dataShareMin);
    if (tail.cause !== 'data') return null;
    const value = Math.round(ratio * 10) / 10;
    const fix = skewFix(stage, ctx, false, tail);
    const dataRatio = tail.attribution?.dataRatio != null
      ? Math.round(tail.attribution.dataRatio * 10) / 10 : undefined;
    return {
      type: 'skew', stageId: stage.id, origin: fix.origin, aqeSkew: fix.aqeSkew,
      cause: tail.cause,
      ...(dataRatio !== undefined ? { dataRatio } : {}),
      impactBand: 'warning',
      metric, value,
      confidence: skewConfidence(ratio, thresholds.ratioWarn),
      validationRequired: `Flagged only when it costs at least ${shareLabel(thresholds.floorPctWarn)} of run time.`,
      recommendation: `Task duration ratio (${metric}) is ${value}×${dataRatio !== undefined ? `, and the slow tasks read a median ${dataRatio}× the data of the median task` : ', and the median task read almost nothing'}: ${fix.text}.`,
      remediation: fix.remediation,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    // computeSkewRatio's own metric labels: 'P95/median' or 'max/median'.
    return tailClaimImpact(skewTailClaim(stage, finding.metric === 'P95/median'), finding.stageId, ctx);
  },
});

export const slowHostDetector = defineStageDetector({
  type: 'slowHost', order: 60, bandPolicy: 'derived', fixEffort: 'config', version: 2,
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
    // and would grade info, and a byte-dimension imbalance (no time estimate, so its ratio tier
    // is its band) is graded info there too. So the stage is skipped.
    stageFloorPct: 0.005,
    // outlierAlpha: the nominal chance a stage of alike tasks gets any executor flagged on task
    // time. The slowest of many executors always tops the median, so a task-time executor is
    // flagged only when its mean sits further above the median than the stage's own task spread
    // and its task count allow (chanceOutlierZ), more strictly the more executors there are.
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
    const tiers = thresholds.ratioTiers;
    const impactBandFor = (r: number): 'critical' | 'warning' | 'info' | null =>
      r >= tiers[3] ? 'critical' : (r >= tiers[1] ? 'warning' : (r >= tiers[0] ? 'info' : null));
    const floorMs = thresholds.floorMs, floorBytes = thresholds.floorBytes;
    const taskTimeSamples = execs.filter(e => e.taskCount > 0).map(e => ({ key: e.executorId, value: e.totalDuration / e.taskCount }));
    const taskTimeZs = executorDurationZ(execs);
    const taskTimeZ = chanceOutlierZ(taskTimeSamples.length, thresholds.outlierAlpha);
    const dims: { dimension: SlowHostMultiDimFinding['dimension']; floor: number; samples: { key: string; value: number }[]; qualifies?: (sample: { key: string; value: number }) => boolean }[] = [
      {
        dimension: 'taskTime', floor: floorMs, samples: taskTimeSamples,
        // Only an executor the stage's own spread can't explain: with no known spread, none.
        qualifies: sample => (taskTimeZs?.get(sample.key) ?? -Infinity) >= taskTimeZ,
      },
      { dimension: 'inputBytes', floor: floorBytes, samples: execs.map(e => ({ key: e.executorId, value: e.inputBytes ?? 0 })) },
      { dimension: 'shuffleBytes', floor: floorBytes, samples: execs.map(e => ({ key: e.executorId, value: (e.shuffleReadBytes ?? 0) + (e.shuffleWriteBytes ?? 0) })) },
    ];
    // Storage-memory dimension: best-effort, only when executorMetrics present.
    const em = stage.executorMetrics instanceof Map ? stage.executorMetrics : null;
    if (em && em.size >= 3) {
      dims.push({ dimension: 'storageMemory', floor: floorBytes, samples: [...em.entries()].map(([id, m]) => ({ key: id, value: (m.onHeapStorageMemory ?? 0) + (m.offHeapStorageMemory ?? 0) })) });
    }
    for (const d of dims) {
      const r = maxMedianRatio(d.samples, d.qualifies);
      if (!r || r.value < d.floor) continue; // absolute-magnitude floor: same ratio+floor shape as computeSpillMagnitude
      const tier = impactBandFor(r.ratio);
      if (!tier) continue;
      // taskTime is the only wallClock-bearing dimension: it takes the fixed fallback band (see
      // threshold-tables.md). The other three never get a wallClock estimate, so they keep the
      // ratio tier.
      const impactBand = d.dimension === 'taskTime' ? 'info' : tier;
      out.push({
        type: 'slowHost', stageId: stage.id, impactBand,
        variant: 'multiDim', dimension: d.dimension,
        metric: 'execMaxMedianRatio', value: Math.round(r.ratio * 10) / 10,
        // `value` is a ratio; `execMaxValue` is the deviating sample's raw magnitude
        // in this dimension's own unit (ms for taskTime, bytes for the rest).
        execMaxValue: r.value,
        executorId: r.key,
        ...(d.dimension === 'taskTime' ? executorTaskTimeCaveat(r.key, r.ratio, d.samples.length, stage.taskCount) : {}),
        recommendation: `Executor ${r.key}'s ${SLOW_HOST_DIMENSION_LABEL[d.dimension]} is ${Math.round(r.ratio * 10) / 10}× the median: investigate uneven partition assignment or a degraded executor.`,
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

export const stragglerDetector = defineStageDetector({
  type: 'straggler', order: 70, bandPolicy: 'derived', fixEffort: 'code', version: 1,
  emits: ['straggler'],
  docAnchor: '#bottleneck-straggler',
  // floorPctWarn/floorPctCrit default to impact-band.ts's run-wide noise floor, so a tail this
  // gate admits at its warn floor grades at least warning there too.
  // shareWarnAtFloor: in a large stage, the few stragglers that gate it for tens of seconds can be
  // only 2.5-5% of its tasks, so a 2.5% share counts once its clipped tail clears floorPctWarn.
  // A stage shorter than floorPctWarn of the run is skipped outright: its tail can't cost more
  // than the stage's own duration, so every finding there would grade info.
  // A tail skew's gate admits and data explains is skew's finding; one it admits whose cause is not
  // data is this one's. Both use skew's thresholds (ctx.skewThresholds), so tuning skew moves both.
  thresholds: { minTasks: 10, shareWarn: 0.05, shareWarnAtFloor: 0.025, warnPct: 0.10, critPct: 0.20, floorPctWarn: IMPACT_FLOOR_PCT_WARN, floorPctCrit: IMPACT_FLOOR_PCT_CRIT },
  detect(stage, ctx, thresholds): Finding | null {
    const skew = ctx.skewThresholds;
    const tail = tailVerdict(stage, skew.dataShareMin);
    const skewTail = skewGate(stage, ctx, skew.ratioWarn, skew.minTasksForP95, skew.floorPctWarn);
    if (tail.cause === 'data' && skewTail !== null) return null; // skew reports it
    // A tail skew's duration gate admits but data does not explain (or nothing attributes) is this finding's.
    const fromSkewGate = skewTail !== null && tail.cause !== 'data';
    const own = stragglerGate(stage, ctx, thresholds);
    if (own === null && !fromSkewGate) return null;
    // Through skew's gate alone the tail can be a share too small to state, so skew's ratio describes it.
    const reported: { metric: MetricName; value: number; unit: 'count' | 'pct' | 'ratio'; detail: string } = own !== null
      ? { metric: own.useSpeculativeMetric ? 'speculativeTasks' : 'stragglerShare', value: own.value, unit: own.useSpeculativeMetric ? 'count' as const : 'pct' as const, detail: own.detail }
      : { metric: skewTail!.metric, value: Math.round(skewTail!.ratio * 10) / 10, unit: 'ratio' as const,
        detail: `Task duration ratio (${skewTail!.metric}) is ${Math.round(skewTail!.ratio * 10) / 10}×` };
    const advice = stragglerAdvice(stage, ctx, tail, reported.detail);
    return {
      type: 'straggler', stageId: stage.id,
      impactBand: 'info', ...advice.evidence,
      metric: reported.metric,
      value: reported.value,
      unit: reported.unit,
      speculativeTasks: stage.speculativeTasks ?? 0,
      stragglerCount: stage.stragglerCount ?? 0,
      confidence: own?.confidence ?? skewConfidence(skewTail!.ratio, skew.ratioWarn),
      validationRequired: `Warning needs at least ${shareLabel(thresholds.floorPctWarn)} of run time at stake, critical ${shareLabel(thresholds.floorPctCrit)}.`,
      recommendation: advice.recommendation,
      remediation: advice.remediation,
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    return tailClaimImpact(stragglerTailClaim(stage), finding.stageId, ctx);
  },
});

export const speculationWasteDetector = defineStageDetector({
  type: 'speculationWaste', order: 71, bandPolicy: 'derived', fixEffort: 'config', version: 1,
  emits: ['speculationWaste'],
  docAnchor: '#bottleneck-speculation-waste',
  thresholds: { minWasted: 5, minWasteMs: 60000 },
  detect(stage, ctx, thresholds): Finding | null {
    const wasted = stage.speculationWastedAttempts ?? 0;
    const wastedMs = stage.speculationWasteMs ?? 0;
    if (wasted < thresholds.minWasted || wastedMs < thresholds.minWasteMs) return null;
    return {
      type: 'speculationWaste', stageId: stage.id,
      impactBand: 'warning',
      metric: 'speculationWasteMs', value: wastedMs,
      confidence: speculationWasteConfidence(wastedMs, thresholds.minWasteMs),
      recommendation: `Speculative execution discarded ${Math.round(wastedMs / 1000)}s of executor time in this stage: if task durations are naturally variable rather than genuine stragglers, consider tuning spark.speculation.multiplier/quantile${speculationRuleNote(ctx.app)}.`,
      remediation: [increaseConf('spark.speculation.multiplier'), increaseConf('spark.speculation.quantile')],
    };
  },
  estimate(finding, ctx): ImpactEstimate | null {
    if (finding.stageId == null) return null;
    const stage = ctx.stages.get(finding.stageId);
    if (!stage) return null;
    const wasteMs = (stage.speculationWasteMs as number | undefined) ?? 0;
    return singleStageImpact(wasteMs, finding.stageId, ctx, 'measured', { value: wasteMs, unit: 'ms' });
  },
});
