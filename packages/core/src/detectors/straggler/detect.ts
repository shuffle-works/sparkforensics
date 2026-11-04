import { IMPACT_BAND_ORDER } from '../../impact-band-order.ts';
import { shareLabel, type MetricName } from '../../finding-presentation.ts';
import { STRAGGLER_FACTOR } from '../../stage-quantiles.ts';
import { IMPACT_FLOOR_PCT_WARN, IMPACT_FLOOR_PCT_CRIT, appDurationMs } from '../../impact-band.ts';
import { increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate } from '../../types.ts';
import type { FindingOf, Remediation, AllKeys, SkewOrigin, AqeSkewCase, TailCause } from '../../finding-types.ts';
import { loggedAs } from '../conf.ts';
import { skewConfidence, stragglerConfidence } from '../confidence.ts';
import { defineStageDetector } from '../define.ts';
import { switchFix } from '../fixes.ts';
import { meetsRuntimeFloor, stageBelowRuntimeFloor } from '../runtime-floor.ts';
import { skewFix } from '../skew-fix.ts';
import { skewGate, stragglerTailClaim, tailClaimFloorMs, tailClaimImpact, tailVerdict, type TailVerdict } from '../tail.ts';
import type { DetectorCtx, DetectorStage } from '../types.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';
import { speculationRuleNote } from '../speculation.ts';

export interface StragglerEvidence {
  // 'ratio' when only skew's duration gate admits the tail: value is its ratio, metric its name.
  unit: 'count' | 'pct' | 'ratio';
  speculativeTasks: number;
  stragglerCount: number;
  // The case the skew advice in the recommendation was written for (see SkewOrigin); set only
  // when the cause is 'data'.
  origin?: SkewOrigin;
  aqeSkew?: AqeSkewCase;
  // 'data' only on a tail skew's own gate does not admit: skew reports every other data-driven tail.
  cause?: TailCause;
  // Share (0-100) of the slow tasks' extra time that the cause accounts for.
  causeSharePct?: number;
  // Set when the cause is 'host': the host most of the slow tasks ran on, and how many did.
  host?: string;
  hostTasks?: number;
  // The slow tasks' CPU time as a share (0-100) of their run time, when the log has CPU time.
  cpuPct?: number;
}

export interface StragglerFinding extends NumericFinding<'straggler'>, StragglerEvidence {}

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

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  straggler: { finding: StragglerFinding; evidence: StragglerEvidence };
}

export const detectors = [stragglerDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  straggler: ['unit', 'speculativeTasks', 'stragglerCount', 'origin', 'aqeSkew', 'cause', 'causeSharePct', 'host', 'hostTasks', 'cpuPct'],
} as const satisfies {
  straggler: readonly AllKeys<StragglerEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  straggler: [],
} as const satisfies {
  straggler: readonly (DiscriminatorSlot & AllKeys<FindingOf<'straggler'>>)[];
};
