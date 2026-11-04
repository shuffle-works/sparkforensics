import { noWasteModel } from '../../impact-model.ts';
import { adviseStageFailure } from '../../failure-advice.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import type { TextFinding } from '../finding-bases.ts';
import type { AllKeys, TaskAttemptSample } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface StageFailedEvidence {
  variant: 'stageFailure';
  numTasks: number;
  memoryBytesSpilled: number;
  failedTaskDetails: TaskAttemptSample[];
}

// valueText is the stage's recorded failure reason.
export interface StageFailedFinding extends TextFinding<'stageFailed'>, StageFailedEvidence {}

export const stageFailedDetector = defineStageDetector({
  type: 'stageFailed', order: 42, bandPolicy: 'failure', fixEffort: 'code', version: 1,
  emits: ['stageFailed'],
  docAnchor: '#bottleneck-failures',
  thresholds: {},
  detect(stage, ctx): Finding | null {
    if (stage.stageFailureReason == null) return null;
    const abortTexts = [
      ...[...ctx.jobs.values()].map((j) => j.exception),
      ...[...ctx.stages.values()].map((s) => (s.id === stage.id ? null : s.stageFailureReason)),
    ].filter((t): t is string => typeof t === 'string');
    const advice = adviseStageFailure(stage.id, stage.stageFailureReason, abortTexts);
    return {
      type: 'stageFailed', stageId: stage.id, impactBand: 'critical',
      variant: 'stageFailure',
      metric: 'stageFailureReason', valueText: stage.stageFailureReason,
      numTasks: stage.taskCount,
      memoryBytesSpilled: stage.memoryBytesSpilled,
      failedTaskDetails: stage.failedTaskSamples ?? [],
      recommendation: advice?.recommendation ?? `This stage attempt failed outright. Inspect the driver log for the failure reason and the job that triggered it.`,
      ...(advice && { remediation: advice.remediation }),
    };
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  stageFailed: { finding: StageFailedFinding; evidence: StageFailedEvidence };
}

export declare const emits: Emits;

export const detectors = [stageFailedDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  stageFailed: ['variant', 'numTasks', 'memoryBytesSpilled', 'failedTaskDetails'],
} as const satisfies {
  stageFailed: readonly AllKeys<StageFailedEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  stageFailed: ['variant'],
} as const satisfies {
  stageFailed: readonly (DiscriminatorSlot & AllKeys<FindingOf<'stageFailed'>>)[];
};
