import type { InterpretationState } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';
import { findingAt } from '@/view/interpretation';
import { triageTargetFor } from '@/view/triage-target';

/** The findings the verdict's steps lead with, in step order. */
export function verdictLeadFindings(interpretation: InterpretationState): Finding[] {
  return interpretation.data.verdict.steps
    .map((step) => findingAt(interpretation, step.leadIndex))
    .filter((finding): finding is Finding => finding != null);
}

/** Which step shows which evidence panel in place: step index to widget id.
 * Every step has its own panel, scoped to its finding, so two steps on one
 * widget each show their own. Only widgets in `available` (the cards the
 * Findings board could show) have one. */
export function verdictEvidenceOwners(
  interpretation: InterpretationState,
  available: ReadonlySet<string>,
): Map<number, string> {
  const owners = new Map<number, string>();
  verdictLeadFindings(interpretation).forEach((finding, index) => {
    const widgetId = triageTargetFor(finding)?.widgetId;
    if (!widgetId || !available.has(widgetId)) return;
    owners.set(index, widgetId);
  });
  return owners;
}
