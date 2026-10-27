// Known failure messages and the fix each one points to, for the failure findings' recommendations.
// Wording varies by cluster manager and Spark version, so patterns match loosely. The raw text stays
// on the finding next to the advice.
import { FAILURE_FIX } from './finding-presentation.ts';
import type { Remediation } from './finding-types.ts';
import { increaseConf } from './remediation.ts';
import type { TaskFailureGroup } from './task-failure.ts';

export interface FailureAdvice {
  id: 'containerMemoryLimit' | 'stageMaxAttempts';
  recommendation: string;
  remediation: Remediation[];
  // 'lab': reproduced in a controlled run. 'text-only': taken from Spark's source or reported text.
  confirmation: 'lab' | 'text-only';
}

interface FailurePattern extends FailureAdvice {
  match: RegExp;
}

// The fix's text lives in FAILURE_FIX, keyed by the property the remediation raises, so a failure
// row's generic line in the dashboard names the same fix.
function pattern(id: FailureAdvice['id'], match: RegExp, confirmation: FailureAdvice['confirmation'], key: keyof typeof FAILURE_FIX): FailurePattern {
  return { id, match, confirmation, recommendation: FAILURE_FIX[key], remediation: [increaseConf(key)] };
}

// Ordered: when a text matches several, the first is the root cause (an aborted stage's reason
// carries the failure that caused the last attempt).
const PATTERNS: FailurePattern[] = [
  pattern('containerMemoryLimit', /exceeding (?:physical |virtual )?memory limits?|OOMKilled|possible container OOM/i, 'text-only', 'spark.executor.memoryOverhead'),
  pattern('stageMaxAttempts', /failed the maximum allowable number of times/i, 'text-only', 'spark.stage.maxConsecutiveAttempts'),
];

/** The advice for the first pattern any of `texts` matches, or null. */
export function adviseFailure(texts: readonly (string | null | undefined)[]): FailureAdvice | null {
  const present = texts.filter((t): t is string => t != null);
  const hit = PATTERNS.find((p) => present.some((t) => p.match.test(t)));
  return hit ? { id: hit.id, recommendation: hit.recommendation, remediation: hit.remediation, confirmation: hit.confirmation } : null;
}

/** The advice for one failed-task group, read from its loss reason, message and class name. */
export function adviseFailureGroup(group: TaskFailureGroup | undefined): FailureAdvice | null {
  return group ? adviseFailure([group.lossReason, group.message, group.className]) : null;
}
