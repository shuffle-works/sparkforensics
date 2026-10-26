import type { Finding } from '@sparkforensics/core/types.ts';

// Types whose evidence panel, for a finding the line above states, holds nothing the
// line does not say: each of the widget's figures is in the finding's sentence.
const LINE_STATES_ALL: ReadonlySet<string> = new Set(['coldStart', 'incompleteRun', 'utilization']);

// The same at the Basic view. The Advanced view adds what the line never shows: a status
// marker (confidence, evidence availability), a model-error line or extended text.
const LINE_STATES_ALL_AT_BASIC: ReadonlySet<string> = new Set([
  'smallFiles',
  'pythonUdf',
  'nestedLoopJoin',
  'underBroadcast',
  'overBroadcast',
  'duplicatePlanSubtree',
  'rightSizing',
  'retryWaste',
]);

/** Whether a finding's in-place evidence panel shows anything beyond the line that
 * states the finding. A widget lists every finding of its type, so another finding
 * of that type always gives the panel something to show. */
export function evidenceAddsDetail(finding: Finding, findings: readonly Finding[], density: 'basic' | 'advanced'): boolean {
  if (findings.some((other) => other.type === finding.type && other.id !== finding.id)) return true;
  if (LINE_STATES_ALL.has(finding.type)) return false;
  if (LINE_STATES_ALL_AT_BASIC.has(finding.type)) return density === 'advanced';
  if (finding.type === 'memoryUtilization') return density === 'advanced' || (finding.variant === 'memoryBand' && !finding.dataUnavailable);
  return true;
}
