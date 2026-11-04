import { noWasteModel } from '../../impact-model.ts';
import { MAX_FAILURE_GROUPS, describeTaskFailure, type TaskFailureGroup } from '../../task-failure.ts';
import { adviseFailureGroup } from '../../failure-advice.ts';
import type { Finding, FindingOf } from '../../types.ts';
import { defineStageDetector } from '../define.ts';
import type { DetectorFailureReason } from '../types.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

export interface FailuresEvidence {
  failedTasks: number;
  dominantReason: string | null;
  dominantError: string | null;
  // One entry per distinct error, most frequent first; otherFailedTasks counts the failed tasks
  // no listed group covers.
  failureGroups: TaskFailureGroup[];
  otherFailedTasks: number;
}

export interface FailuresFinding extends NumericFinding<'failures'>, FailuresEvidence {}

function pickDominantReason(reasons: DetectorFailureReason[] | undefined): string | null {
  if (!Array.isArray(reasons) || reasons.length === 0) return null;
  return [...reasons].sort((a, b) => b.count - a.count)[0].reason;
}

// Groups arrive most frequent first: the largest group under the dominant reason tag, so a named
// error or its advice agrees with the tag even when one tag splits into many messages.
function dominantFailureGroup(stage: { failureReasons?: DetectorFailureReason[]; failureGroups?: TaskFailureGroup[] }): TaskFailureGroup | undefined {
  const dominantReason = pickDominantReason(stage.failureReasons);
  return stage.failureGroups?.find((g) => g.reason === dominantReason);
}

export const failuresDetector = defineStageDetector({
  type: 'failures', order: 40, bandPolicy: 'own', fixEffort: 'code', version: 2,
  emits: ['failures'],
  docAnchor: '#bottleneck-failures',
  thresholds: { minTasks: 10, warnRate: 0.05, critRate: 0.20 },
  detect(stage, _ctx, thresholds): Finding | null {
    if (stage.taskCount < thresholds.minTasks) return null;
    if (!stage.failedTasks) return null;
    const failureRate = stage.failedTasks / stage.taskCount;
    if (failureRate <= thresholds.warnRate) return null;
    const value = Math.round(failureRate * 1000) / 10;
    const dominantReason = pickDominantReason(stage.failureReasons);
    const allGroups = stage.failureGroups ?? [];
    const dominantGroup = dominantFailureGroup(stage);
    const dominantError = (dominantGroup ? describeTaskFailure(dominantGroup) : null) ?? dominantReason;
    const failureGroups = allGroups.slice(0, MAX_FAILURE_GROUPS);
    const groupedTasks = failureGroups.reduce((sum, g) => sum + g.count, 0);
    const advice = adviseFailureGroup(dominantGroup);
    return {
      type: 'failures', stageId: stage.id,
      impactBand: failureRate > thresholds.critRate ? 'critical' : 'warning',
      metric: 'failureRate', value,
      failedTasks: stage.failedTasks,
      dominantReason,
      dominantError,
      // One entry per distinct error (tag, class, message, loss reason), each with one bounded
      // stack excerpt; otherFailedTasks counts the failed tasks no shown group covers.
      failureGroups,
      otherFailedTasks: Math.max(0, stage.failedTasks - groupedTasks),
      recommendation: `${value}% of tasks failed${dominantError ? ` (dominant error: ${dominantError})` : ''}: ${advice?.recommendation ?? 'investigate driver logs for executor instability or data-driven errors.'}`,
      ...(advice && { remediation: advice.remediation }),
    };
  },
  estimate: noWasteModel,
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  failures: { finding: FailuresFinding; evidence: FailuresEvidence };
}

export declare const emits: Emits;

export const detectors = [failuresDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  failures: ['failedTasks', 'dominantReason', 'dominantError', 'failureGroups', 'otherFailedTasks'],
} as const satisfies {
  failures: readonly AllKeys<FailuresEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  failures: [],
} as const satisfies {
  failures: readonly (DiscriminatorSlot & AllKeys<FindingOf<'failures'>>)[];
};
