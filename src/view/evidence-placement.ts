import type { InterpretationState } from '@/store/store';
import type { Finding } from '@sparkforensics/core/types.ts';
import { findingAt, eligibleFindings } from '@/view/interpretation';
import { triageTargetFor } from '@/view/triage-target';

export type EvidencePlacement =
  | { kind: 'step'; index: number; widgetId: string | null }
  | { kind: 'row'; widgetId: string | null }
  | { kind: 'card'; widgetId: string }
  | { kind: 'none' };

/** The one placement decision for a finding. A step and a board row remain
 * useful when their widget has no evidence panel; only a card requires an
 * available widget. */
export function evidencePlacement(
  interpretation: InterpretationState,
  finding: Finding,
  availableWidgetIds: ReadonlySet<string>,
): EvidencePlacement {
  const widgetId = triageTargetFor(finding)?.widgetId ?? null;
  const stepIndex = interpretation.data.verdict.steps.findIndex(
    (step) => findingAt(interpretation, step.leadIndex) === finding,
  );
  if (stepIndex >= 0) return { kind: 'step', index: stepIndex, widgetId };
  if (eligibleFindings(interpretation).includes(finding)) return { kind: 'row', widgetId: widgetId && availableWidgetIds.has(widgetId) ? widgetId : null };
  if (widgetId && availableWidgetIds.has(widgetId)) return { kind: 'card', widgetId };
  return { kind: 'none' };
}
