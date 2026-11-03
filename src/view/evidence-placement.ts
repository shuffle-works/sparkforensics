import type { InterpretationState } from '@/view/interpretation';
import type { Finding } from '@sparkforensics/core/types.ts';
import { eligibleFindings, findingById } from '@/view/interpretation';
import { triageTargetFor } from '@/view/triage-target';

export type EvidencePlacement =
  | { kind: 'step'; index: number; widgetId: string | null }
  | { kind: 'row'; widgetId: string | null }
  | { kind: 'card'; widgetId: string }
  | { kind: 'none' };

/** The one placement decision for a finding. A step and a board row remain
 * useful when their widget has no evidence panel (their widget id is then
 * null); only a card requires an available widget. */
export function evidencePlacement(
  interpretation: InterpretationState,
  finding: Finding,
  availableWidgetIds: ReadonlySet<string>,
): EvidencePlacement {
  const targetId = triageTargetFor(finding)?.widgetId ?? null;
  const widgetId = targetId && availableWidgetIds.has(targetId) ? targetId : null;
  const stepIndex = interpretation.data.verdict.steps.findIndex(
    (step) => findingById(interpretation, step.leadId) === finding,
  );
  if (stepIndex >= 0) return { kind: 'step', index: stepIndex, widgetId };
  if (eligibleFindings(interpretation).includes(finding)) return { kind: 'row', widgetId };
  if (widgetId) return { kind: 'card', widgetId };
  return { kind: 'none' };
}
