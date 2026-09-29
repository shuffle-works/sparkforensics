import { FINDING_PRESENTATION, presentationOf } from './finding-presentation.ts';
import type { Finding, FindingType } from './types.ts';

// Finding `type` -> human-readable label, derived from FINDING_PRESENTATION. The web uses it
// lowercase; evidence-report.ts Title Cases it for CLI/MCP names. Declared string-indexed for
// lookups by a type read from report JSON or a filter.
export const FINDING_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  (Object.keys(FINDING_PRESENTATION) as FindingType[]).map((type) => [type, FINDING_PRESENTATION[type].name]),
);

/** A finding type's name, or the raw type string for a type with no presentation row. */
export function findingName(type: string): string {
  return presentationOf(type)?.name ?? type;
}

// Capitalizes the first letter of each word, leaving other characters untouched so acronyms
// ('GC', 'I/O') survive.
export function titleCase(label: string): string {
  return label.replace(/\b\w/g, (c) => c.toUpperCase());
}

/** The finding's own recommendation, or its type's name when it has none. */
export function recommendationText(finding: Finding): string {
  const text = typeof finding.recommendation === 'string' ? finding.recommendation.trim() : '';
  if (text) return text;
  return findingName(finding.type);
}
