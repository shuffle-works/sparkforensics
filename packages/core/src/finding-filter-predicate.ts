// Core-owned finding-filter predicate, shared by the CLI/MCP evidence report and the dashboard's
// filter bar (its view counterpart wraps this instead of reimplementing). Each dimension is
// unconstrained when empty; a stageId criterion only matches a row whose own stageId is present.
type Membership<T> = ReadonlySet<T> | readonly T[];

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
 * finding's `stageIds`. Null for an app-level, config or multi-stage finding. The same rule the
 * run verdict groups steps by and the stage dialog lists a stage's findings by. */
export function singleStageId(row: { stageId?: number | null; stageIds?: readonly number[] | null }): number | null {
  if (typeof row.stageId === 'number') return row.stageId;
  if (row.stageIds && row.stageIds.length === 1) return row.stageIds[0];
  return null;
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
