import { costOnly } from '../../impact-model.ts';
import { increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate } from '../../types.ts';
import type { FindingOf, AllKeys } from '../../finding-types.ts';
import { speculationWasteConfidence } from '../confidence.ts';
import { defineStageDetector } from '../define.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';
import { speculationRuleNote } from '../speculation.ts';

export type SpeculationWasteEvidence = Record<never, never>;

export interface SpeculationWasteFinding extends NumericFinding<'speculationWaste'>, SpeculationWasteEvidence {}

export const speculationWasteDetector = defineStageDetector({
  type: 'speculationWaste', order: 71, bandPolicy: 'own', fixEffort: 'config', version: 2,
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
    // Losing copies run on spare slots beside their originals: they cost core time, not run time.
    return costOnly('measured', { value: wasteMs, unit: 'ms' });
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  speculationWaste: { finding: SpeculationWasteFinding; evidence: SpeculationWasteEvidence };
}

export declare const emits: Emits;

export const detectors = [speculationWasteDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  speculationWaste: [],
} as const satisfies {
  speculationWaste: readonly AllKeys<SpeculationWasteEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  speculationWaste: [],
} as const satisfies {
  speculationWaste: readonly (DiscriminatorSlot & AllKeys<FindingOf<'speculationWaste'>>)[];
};
