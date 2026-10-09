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

/** Which step shows which evidence card in place: step index to widget id.
 * A card renders once, so the first step that targets a widget owns it; a
 * later step on the same widget routes to the owner's card. Only widgets in
 * `available` (the cards the Findings board could show) are claimed. */
export function verdictEvidenceOwners(
  interpretation: InterpretationState,
  available: ReadonlySet<string>,
): Map<number, string> {
  const owners = new Map<number, string>();
  const claimed = new Set<string>();
  verdictLeadFindings(interpretation).forEach((finding, index) => {
    const widgetId = triageTargetFor(finding)?.widgetId;
    if (!widgetId || !available.has(widgetId) || claimed.has(widgetId)) return;
    claimed.add(widgetId);
    owners.set(index, widgetId);
  });
  return owners;
}
