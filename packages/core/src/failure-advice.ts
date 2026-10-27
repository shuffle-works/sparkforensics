// Known failure messages and the fix each one points to, for the failure findings' recommendations.
// Wording varies by cluster manager and Spark version, so patterns match loosely. The raw text stays
// on the finding next to the advice.
import type { Remediation } from './finding-types.ts';
import { increaseConf } from './remediation.ts';
import type { TaskFailureGroup } from './task-failure.ts';

export interface FailureAdvice {
  id: 'containerMemoryLimit' | 'stageMaxAttempts';
  recommendation: string;
  remediation: Remediation[];
}

interface FailurePattern extends FailureAdvice {
  match: RegExp;
  // 'lab': reproduced in a controlled run. 'text-only': taken from Spark's source or reported text.
  confirmation: 'lab' | 'text-only';
}

// Ordered: when a text matches several, the first is the root cause (an aborted stage's reason
// carries the failure that caused the last attempt).
const PATTERNS: FailurePattern[] = [
  {
    id: 'containerMemoryLimit',
    match: /exceeding (?:physical |virtual )?memory limits?|OOMKilled|possible container OOM/i,
    confirmation: 'text-only',
    recommendation: 'The cluster manager killed executors that used more memory than their container allows. Raise spark.executor.memoryOverhead, which holds off-heap, native and Python worker memory, or lower spark.executor.cores so fewer tasks share each container.',
    remediation: [increaseConf('spark.executor.memoryOverhead')],
  },
  {
    id: 'stageMaxAttempts',
    match: /failed the maximum allowable number of times/i,
    confirmation: 'text-only',
    recommendation: 'The stage was aborted after failing its maximum number of consecutive attempts, usually because executors or nodes were lost again and again. Fix the loss first. Raise spark.stage.maxConsecutiveAttempts only to ride out loss that clears on its own.',
    remediation: [increaseConf('spark.stage.maxConsecutiveAttempts')],
  },
];

/** The advice for the first pattern any of `texts` matches, or null. */
export function adviseFailure(texts: readonly (string | null | undefined)[]): FailureAdvice | null {
  const present = texts.filter((t): t is string => t != null);
  const hit = PATTERNS.find((p) => present.some((t) => p.match.test(t)));
  return hit ? { id: hit.id, recommendation: hit.recommendation, remediation: hit.remediation } : null;
}

/** The advice for a stage's failed-task groups: the first group with a known message wins, and
 * groups arrive most frequent first. */
export function adviseFailureGroups(groups: readonly TaskFailureGroup[]): FailureAdvice | null {
  for (const g of groups) {
    const advice = adviseFailure([g.lossReason, g.message, g.className]);
    if (advice) return advice;
  }
  return null;
}
