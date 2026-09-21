import type { Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY, orderedWidgets } from './detector-registry';
import type { WidgetRegion } from './detector-registry';

export interface TriageTarget {
  finding: Finding;
  widgetId: string;
  region: WidgetRegion;
  findingLabel: string;
  stageId: number | null;
  recommendation: string;
}

function targetForFinding(finding: Finding): TriageTarget | null {
  const entry = REGISTRY[finding.type];
  const recommendation = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';

  if (!entry?.routeable || !recommendation) return null;

  return {
    finding,
    widgetId: entry.widgetId,
    region: entry.region,
    findingLabel: entry.findingLabel,
    stageId: typeof finding.stageId === 'number' ? finding.stageId : null,
    recommendation,
  };
}

// Findings are held by reference: a new file/catalog yields new object refs, so
// reference presence (not a value key) is the identity that detects staleness.
export function selectTriageTargetForFinding(finding: Finding, catalog: Finding[]): TriageTarget | null {
  if (!catalog.includes(finding)) return null;
  return targetForFinding(finding);
}

// The high end of the finding's own occupancy-clipped wall-clock estimate
// (src/impact-estimator.ts), the same figure ImpactEstimate.tsx's "Potential
// savings" line leads with. `null` when there's no quantified time claim
// (resourceOnly/informational basis): such a finding can't be compared
// against one that does have a real estimate, so it can never win the
// "biggest win" callout on its own numbers.
function potentialSavingsMs(finding: Finding): number | null {
  return finding.impactEstimate?.wallClock?.high ?? null;
}

export function selectTriageTarget(catalog: Finding[]): TriageTarget | null {
  const widgetOrder = new Map(orderedWidgets().map((widget, index) => [widget.widgetId, index]));
  const candidates = catalog
    .map((finding, catalogIndex) => ({ target: targetForFinding(finding), catalogIndex }))
    .filter((candidate): candidate is { target: TriageTarget; catalogIndex: number } => candidate.target !== null);

  // Ranked by potential savings: every finding's impact band is now itself
  // derived from savings where one exists, so this ranking and that band
  // agree by construction rather than needing to be reconciled. A quantified
  // estimate always outranks an unquantified one; ties (including "neither
  // has one") fall back to widget display order, then catalog order.
  candidates.sort((left, right) => {
    const leftSavings = potentialSavingsMs(left.target.finding);
    const rightSavings = potentialSavingsMs(right.target.finding);
    if (leftSavings !== null && rightSavings !== null && leftSavings !== rightSavings) {
      return rightSavings - leftSavings;
    }
    if ((leftSavings !== null) !== (rightSavings !== null)) {
      return leftSavings !== null ? -1 : 1;
    }
    return (
      (widgetOrder.get(left.target.widgetId) ?? Number.MAX_SAFE_INTEGER) - (widgetOrder.get(right.target.widgetId) ?? Number.MAX_SAFE_INTEGER)
      || left.catalogIndex - right.catalogIndex
    );
  });

  return candidates[0]?.target ?? null;
}

export function formatTriageCopy(target: TriageTarget): {
  actionLabel: string;
  confidence: string | null;
  validationRequired: string | null;
} {
  const confidence = target.finding.confidence;
  const validationRequired = target.finding.validationRequired;
  const needsValidation = confidence !== 'high';

  return {
    actionLabel: `Start with ${target.findingLabel}${typeof target.stageId === 'number' ? ` in Stage ${target.stageId}` : ''}`,
    confidence: needsValidation && typeof confidence === 'string' ? confidence : null,
    validationRequired: needsValidation && typeof validationRequired === 'string' && validationRequired.trim()
      ? validationRequired
      : null,
  };
}
