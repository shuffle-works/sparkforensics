import type { Finding } from '@sparkforensics/core/types.ts';
import { findingStageIds } from '@sparkforensics/core/findings-of-type.ts';
import type { InterpretationState } from '@/store/store';
import { rankedBySavings } from './interpretation';

/** `'impact'` ranks as the verdict does (stage task time, then potential savings);
 * `'stage'` ranks by stage number ascending. */
export type SortMode = 'impact' | 'stage';

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

/** Items in the interpretation's savings rank (core's `rankBySavings`, the order of `verdict.steps`).
 * An item takes the place of its best-ranked finding; items with none keep their order after the
 * rest. */
export function orderByImpact<T>(
  state: InterpretationState | null,
  items: readonly T[],
  getFindings: (item: T) => readonly Finding[],
): T[] {
  const place = new Map(rankedBySavings(state, items.flatMap(getFindings)).map((f, i) => [f, i]));
  const keyed = items.map((item) => ({
    item,
    key: Math.min(Number.MAX_SAFE_INTEGER, ...getFindings(item).map((f) => place.get(f) ?? Number.MAX_SAFE_INTEGER)),
  }));
  return keyed.sort((a, b) => a.key - b.key).map(({ item }) => item);
}

/** A finding's own stage number: `stageId` for a per-stage detector, or the
 * lowest id in `stageIds` for a sql-scope finding that spans several stages
 * (duplicatePlanSubtree, smallFiles, nestedLoopJoin, pythonUdf, underBroadcast, overBroadcast). `null`
 * for an app-level finding with neither field set. */
export function stageIdOf(finding: Finding): number | null {
  if (finding.stageId != null) return finding.stageId;
  const stageIds = findingStageIds(finding);
  if (stageIds && stageIds.length > 0) return Math.min(...stageIds);
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
