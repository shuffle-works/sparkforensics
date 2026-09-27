import { rankBySavings } from '@sparkforensics/core/run-verdict.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { REGISTRY } from './detector-registry';
import type { WidgetRegion } from './detector-registry';

export interface TriageTarget {
  finding: Finding;
  widgetId: string;
  region: WidgetRegion;
  findingLabel: string;
  stageId: number | null;
  recommendation: string;
}

/** The route to a finding's widget, or null when its type has no routeable widget or the
 * finding has no recommendation. */
export function triageTargetFor(finding: Finding): TriageTarget | null {
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
  return triageTargetFor(finding);
}

export function selectTriageTarget(catalog: Finding[]): TriageTarget | null {
  return rankTriageTargets(catalog)[0] ?? null;
}

/** Every routeable finding as a triage target, best first: core's potential-savings ranking
 * (`rankBySavings`, shared with the CLI/MCP verdict). */
export function rankTriageTargets(catalog: Finding[]): TriageTarget[] {
  return rankBySavings(catalog)
    .map(triageTargetFor)
    .filter((target): target is TriageTarget => target !== null);
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
