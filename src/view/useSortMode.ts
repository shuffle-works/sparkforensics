import { useState } from 'react';

import type { Finding } from '@sparkforensics/core/types.ts';
import { byImpactDesc, byStageAsc, type SortMode } from '@/view/impact-sort';
import { useWidgetDensity } from '@/store/store';

export interface UseSortModeResult {
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  /** Applies the current `sortMode` to a list of items: impact-descending
   * (`byImpactDesc`) or stage-ascending (`byStageAsc`), given each item's own
   * findings/stage-id accessors. */
  orderBy: <T>(
    items: T[],
    getFindings: (item: T) => readonly Finding[],
    getStageId: (item: T) => number | null,
  ) => T[];
}

/** Shared `sortMode` state + ordering for the widgets that render a
 * `SortModeToggle` (impact order vs. stage order). Doesn't own pagination
 * (see `usePagedRows`) or the toggle's own visibility gate
 * (`hasSortableImpact`, src/view/impact-sort.ts): callers still decide those
 * for themselves, since gating differs per widget (some also reset a page
 * cursor on change). Re-ordering by stage is Advanced-only (`SortModeToggle`
 * is itself gated), so at Basic both the returned `sortMode` and `orderBy`
 * are forced to impact order regardless of the raw stored state: flipping
 * density back to Basic after choosing stage order in Advanced can't leave a
 * widget stuck showing stage order with no visible control to undo it. The
 * raw choice is preserved underneath, so switching back to Advanced restores
 * it. */
export function useSortMode(initial: SortMode = 'impact'): UseSortModeResult {
  const [sortMode, setSortMode] = useState<SortMode>(initial);
  const density = useWidgetDensity();
  const effectiveMode: SortMode = density === 'advanced' ? sortMode : 'impact';

  function orderBy<T>(
    items: T[],
    getFindings: (item: T) => readonly Finding[],
    getStageId: (item: T) => number | null,
  ): T[] {
    return effectiveMode === 'impact'
      ? [...items].sort(byImpactDesc(getFindings))
      : [...items].sort(byStageAsc(getStageId));
  }

  return { sortMode: effectiveMode, setSortMode, orderBy };
}
