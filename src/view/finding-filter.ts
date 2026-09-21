import type { Finding, ImpactBand } from '@sparkforensics/core/types.ts';
import { matchesFindingFilterCriteria } from '@sparkforensics/core/finding-filter-predicate.ts';

/** Fixed impact-band vocabulary, in triage order. */
export const IMPACT_BANDS: readonly ImpactBand[] = ['critical', 'warning', 'info'];

export interface FilterSelection {
  impactBands: Set<ImpactBand>;
  /** Raw `finding.type` values (not the collapsed display tag). */
  types: Set<string>;
  stages: Set<number>;
}

export function emptySelection(): FilterSelection {
  return { impactBands: new Set(), types: new Set(), stages: new Set() };
}

export function isEmptySelection(sel: FilterSelection): boolean {
  return sel.impactBands.size === 0 && sel.types.size === 0 && sel.stages.size === 0;
}

/**
 * One predicate for both the catalog and the config-audit stream. Each empty
 * dimension is unconstrained. The stage clause requires a real `stageId`, so a
 * non-empty stage filter drops every `stageId: null` finding (app/SQL/config).
 * Delegates to the shared core predicate (src/finding-filter-predicate.ts)
 * that also backs the CLI/MCP evidence report's FindingsFilter.
 */
export function matchesFilter(finding: Finding, sel: FilterSelection): boolean {
  return matchesFindingFilterCriteria(finding, {
    impactBand: sel.impactBands,
    type: sel.types,
    stageId: sel.stages,
  });
}

export function filterFindings(findings: Finding[], sel: FilterSelection): Finding[] {
  return findings.filter((finding) => matchesFilter(finding, sel));
}

export interface FilterOptions {
  impactBands: ImpactBand[];
  types: string[];
  stages: number[];
}

/** Only the impact bands / raw types / stageIds actually present are offered. */
export function deriveOptions(catalog: Finding[], configFindings: Finding[]): FilterOptions {
  const impactBands = new Set<ImpactBand>();
  const types = new Set<string>();
  const stages = new Set<number>();
  for (const finding of [...catalog, ...configFindings]) {
    impactBands.add(finding.impactBand);
    types.add(finding.type);
    if (finding.stageId != null) stages.add(finding.stageId);
  }
  return {
    impactBands: IMPACT_BANDS.filter((b) => impactBands.has(b)),
    types: [...types].sort(),
    stages: [...stages].sort((a, b) => a - b),
  };
}

function splitParam(value: string | null): string[] {
  if (!value) return [];
  return value.split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Seed a selection from a URL query string. `impact` is validated against the
 * fixed impact-band union, `type` against types present in the current catalog
 * (`options.types`), `stage` against integers. Anything else is dropped
 * silently (fail-safe: show more, never error).
 */
export function parseFilterSelection(search: string, options: FilterOptions): FilterSelection {
  const params = new URLSearchParams(search);
  const sel = emptySelection();

  for (const v of splitParam(params.get('impact'))) {
    if ((IMPACT_BANDS as readonly string[]).includes(v)) sel.impactBands.add(v as ImpactBand);
  }
  const validTypes = new Set(options.types);
  for (const v of splitParam(params.get('type'))) {
    if (validTypes.has(v)) sel.types.add(v);
  }
  for (const v of splitParam(params.get('stage'))) {
    const n = Number(v);
    if (Number.isInteger(n)) sel.stages.add(n);
  }
  return sel;
}

/** Encode the active selection as a query string (`''` when unconstrained). */
export function serializeFilterSelection(sel: FilterSelection): string {
  const parts: string[] = [];
  if (sel.impactBands.size) parts.push(`impact=${IMPACT_BANDS.filter((b) => sel.impactBands.has(b)).join(',')}`);
  if (sel.types.size) parts.push(`type=${[...sel.types].sort().join(',')}`);
  if (sel.stages.size) parts.push(`stage=${[...sel.stages].sort((a, b) => a - b).join(',')}`);
  return parts.length ? `?${parts.join('&')}` : '';
}
