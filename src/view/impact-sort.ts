import type { Finding } from '@sparkforensics/core/types.ts';

/** `'impact'` ranks by potential savings (`wallClock.low`, descending);
 * `'stage'` ranks by stage number ascending. */
export type SortMode = 'impact' | 'stage';

/** Sums `wallClock.low` across a list of findings tied to one row/group, or
 * `null` when none of them carry a wall-clock claim (a `resourceOnly`/
 * `informational` estimate isn't comparable to a time figure; see
 * impact-estimation.md). `low` is the guaranteed-floor bound, not `high`, so
 * a contended finding's optimistic upper bound never outranks a serial
 * finding's smaller but certain figure. */
export function sumWallClockLow(findings: readonly Finding[]): number | null {
  let total = 0;
  let sawTime = false;
  for (const f of findings) {
    const wallClock = f.impactEstimate?.wallClock;
    if (wallClock) {
      sawTime = true;
      total += wallClock.low;
    }
  }
  return sawTime ? total : null;
}

/** True when at least one item in the list would actually move under an
 * impact sort: gates whether a widget bothers rendering the sort toggle at
 * all, since re-sorting a list with no wall-clock claims is a silent no-op. */
export function hasSortableImpact(findings: readonly Finding[]): boolean {
  return findings.some((f) => f.impactEstimate?.wallClock != null);
}

/** Whether a widget should render its `SortModeToggle`: sortable impact data
 * exists, there's more than one row to reorder, and the card is open (a
 * collapsed card has nothing to reorder yet). `rowCount` is the widget's own
 * row/group count, which isn't always `findings.length` (e.g. a widget may
 * gate on its rendered row-group count instead). */
export function canToggleSort(findings: readonly Finding[], rowCount: number, cardOpen: boolean): boolean {
  return hasSortableImpact(findings) && rowCount > 1 && cardOpen;
}

/** Comparator: descending potential savings, items with no wall-clock claim
 * sink to the bottom, ties fall through to `Array.prototype.sort`'s
 * stability (so the widget's own pre-existing order survives as the
 * tiebreak). */
export function byImpactDesc<T>(getFindings: (item: T) => readonly Finding[]) {
  return (a: T, b: T): number => {
    const aImpact = sumWallClockLow(getFindings(a));
    const bImpact = sumWallClockLow(getFindings(b));
    if (aImpact == null && bImpact == null) return 0;
    if (aImpact == null) return 1;
    if (bImpact == null) return -1;
    return bImpact - aImpact;
  };
}

/** A finding's own stage number: `stageId` for a per-stage detector, or the
 * lowest id in `stageIds` for a sql-scope finding that spans several stages
 * (duplicatePlanSubtree, smallFiles, underBroadcast, overBroadcast). `null`
 * for an app-level finding with neither field set. */
export function stageIdOf(finding: Finding): number | null {
  if (finding.stageId != null) return finding.stageId;
  if (finding.stageIds && finding.stageIds.length > 0) return Math.min(...finding.stageIds);
  return null;
}

/** Comparator: ascending stage number, items with no stage number sink to
 * the bottom, ties fall through to `Array.prototype.sort`'s stability. */
export function byStageAsc<T>(getStageId: (item: T) => number | null) {
  return (a: T, b: T): number => {
    const aId = getStageId(a);
    const bId = getStageId(b);
    if (aId == null && bId == null) return 0;
    if (aId == null) return 1;
    if (bId == null) return -1;
    return aId - bId;
  };
}
