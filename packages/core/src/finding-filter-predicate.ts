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
