import { noWasteModel } from '../../impact-model.ts';
import { runTiming } from '../../run-timing.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defineAppDetector } from '../define.ts';
import type { TextFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export type IncompleteRunEvidence = Record<never, never>;

// valueText is always 'missing': the ApplicationEnd event the log lacks.
export interface IncompleteRunFinding extends TextFinding<'incompleteRun'>, IncompleteRunEvidence {}

const INCOMPLETE_RUN_RECOMMENDATION = 'This event log never recorded an ApplicationEnd event: the capture stopped before the run finished (a job still running, a rotated log, or a cut-short capture), so every figure on this board covers only what was captured.';

export const incompleteRunDetector = defineAppDetector({
  // No docAnchor: the upstream spark-tuning-reference docs have no section for this
  // tool-specific "capture stopped early" signal.
  type: 'incompleteRun', order: 5, bandPolicy: 'own', fixEffort: 'code', version: 1,
  emits: ['incompleteRun'],
  thresholds: {},
  detect(ctx): Finding | null {
    if (!runTiming(ctx.app).incomplete) return null;
    return {
      type: 'incompleteRun', stageId: null, impactBand: 'warning',
      metric: 'applicationEnd', valueText: 'missing',
      recommendation: INCOMPLETE_RUN_RECOMMENDATION,
    };
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  incompleteRun: { finding: IncompleteRunFinding; evidence: IncompleteRunEvidence };
}

export const detectors = [incompleteRunDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  incompleteRun: [],
} as const satisfies {
  incompleteRun: readonly AllKeys<IncompleteRunEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  incompleteRun: [],
} as const satisfies {
  incompleteRun: readonly (DiscriminatorSlot & AllKeys<FindingOf<'incompleteRun'>>)[];
};
