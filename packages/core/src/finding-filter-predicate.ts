// Core-owned finding-filter predicate, shared by the CLI/MCP evidence report and the dashboard's
// filter bar (its view counterpart wraps this instead of reimplementing). Each dimension is
// unconstrained when empty; a stageId criterion only matches a row whose own stageId is present.
import { IMPACT_BAND_ORDER, IMPACT_BANDS } from './format-utils.ts';
import type { ImpactBand } from './types.ts';

type Membership<T> = ReadonlySet<T> | readonly T[];

/** The least severe band a listing shows when nothing names a band. Info findings are notes:
 * they are listed once the listing asks for the info band. The dashboard, CLI and MCP all read it. */
export const DEFAULT_MIN_BAND: ImpactBand = 'warning';

/** The bands a listing that names none shows: `DEFAULT_MIN_BAND` and every more severe one. */
export const DEFAULT_IMPACT_BANDS: readonly ImpactBand[] = IMPACT_BANDS
  .filter((band) => IMPACT_BAND_ORDER[band] <= IMPACT_BAND_ORDER[DEFAULT_MIN_BAND]);

/** The info notes a listing leaves out: info rows that `matches` rejects, though they would match
 * at the default band, so every other filter kept them. */
export function countHiddenNotes<T extends { impactBand: string }>(rows: readonly T[], matches: (row: T) => boolean): number {
  return rows.filter((row) => row.impactBand === 'info' && !matches(row) && matches({ ...row, impactBand: DEFAULT_MIN_BAND })).length;
}

function isNonEmpty<T>(m: Membership<T> | undefined): m is Membership<T> {
  if (m == null) return false;
  return (Array.isArray(m) ? m.length : (m as ReadonlySet<T>).size) > 0;
}

function has<T>(m: Membership<T>, value: T): boolean {
  return Array.isArray(m) ? m.includes(value) : (m as ReadonlySet<T>).has(value);
}

export interface FindingFilterCriteria {
  impactBand?: Membership<string>;
  type?: Membership<string>;
  stageId?: number | Membership<number>;
}

/** The one stage a finding is about: its own `stageId`, or the only entry of a sql-scope
 * finding's `stageIds`. Null for an app-level, config or multi-stage finding. The run verdict
 * groups its steps by it. */
export function singleStageId(row: { stageId?: number | null; stageIds?: readonly number[] | null }): number | null {
  if (typeof row.stageId === 'number') return row.stageId;
  if (row.stageIds && row.stageIds.length === 1) return row.stageIds[0];
  return null;
}

type StageRow = { stageId?: number | null; stageIds?: readonly number[] | null };

/** Every stage a finding is about: its own `stageId` and the entries of a sql-scope finding's
 * `stageIds`. A stage's row, its dialog, the plan graph and the Topbar all list a finding on
 * each of these. */
export function stagesOfFinding(row: StageRow): number[] {
  const stages = typeof row.stageId === 'number' ? [row.stageId] : [];
  for (const stageId of row.stageIds ?? []) if (!stages.includes(stageId)) stages.push(stageId);
  return stages;
}

/** The findings about `stageId` (`stagesOfFinding`). */
export function findingsForStage<T extends StageRow>(findings: readonly T[], stageId: number): T[] {
  return findings.filter((finding) => stagesOfFinding(finding).includes(stageId));
}

export function matchesFindingFilterCriteria(
  row: { impactBand: string; type: string; stageId?: number | null },
  criteria: FindingFilterCriteria,
): boolean {
  if (isNonEmpty(criteria.impactBand) && !has(criteria.impactBand, row.impactBand)) return false;
  if (isNonEmpty(criteria.type) && !has(criteria.type, row.type)) return false;
  const { stageId } = criteria;
  if (typeof stageId === 'number') {
    if (row.stageId !== stageId) return false;
  } else if (isNonEmpty(stageId)) {
    if (row.stageId == null || !has(stageId, row.stageId)) return false;
  }
  return true;
}
