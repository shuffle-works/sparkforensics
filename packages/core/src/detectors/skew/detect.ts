import { shareLabel } from '../../finding-presentation.ts';
import { IMPACT_FLOOR_PCT_WARN } from '../../impact-band.ts';
import type { Finding, ImpactEstimate } from '../../types.ts';
import type { FindingOf, AllKeys, SkewOrigin, AqeSkewCase, TailCause } from '../../finding-types.ts';
import { skewConfidence } from '../confidence.ts';
import { defineStageDetector } from '../define.ts';
import { skewFix } from '../skew-fix.ts';
import { skewGate, skewTailClaim, tailClaimImpact, tailVerdict } from '../tail.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface SkewEvidence {
  origin?: SkewOrigin;
  // Only on origin 'shuffleJoin' with AQE skew-join handling on and the join resolved from the plan.
  aqeSkew?: AqeSkewCase;
  // Always 'data'; a stage whose tail is not data, or has no measured cause, does not get a skew finding.
  cause?: TailCause;
  // Median over the slow tasks of how many times the median task's data each read.
  dataRatio?: number;
}

export interface SkewFinding extends NumericFinding<'skew'>, SkewEvidence {}

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

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  skew: { finding: SkewFinding; evidence: SkewEvidence };
}

export declare const emits: Emits;

export const detectors = [skewDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  skew: ['origin', 'aqeSkew', 'cause', 'dataRatio'],
} as const satisfies {
  skew: readonly AllKeys<SkewEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  skew: [],
} as const satisfies {
  skew: readonly (DiscriminatorSlot & AllKeys<FindingOf<'skew'>>)[];
};
