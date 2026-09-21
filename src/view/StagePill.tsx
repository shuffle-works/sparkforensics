import { useState } from 'react';

import { useStageDetail } from '@/view/StageDetailContext';
import { cn } from '@/lib/utils';
import { VISIBLE_LIMIT } from '@sparkforensics/core/format-utils.ts';

const pillClassName =
  'inline-flex h-7 shrink-0 cursor-pointer items-center gap-1 rounded-full border border-border bg-background px-2.5 text-xs font-medium whitespace-nowrap outline-none transition-colors hover:bg-muted focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50';

export interface StagePillProps {
  stageId: number;
  className?: string;
}

/** Opens the stage-detail dialog for a single stage via
 * `useStageDetail().openStage`. */
export function StagePill({ stageId, className }: StagePillProps) {
  const { openStage } = useStageDetail();
  return (
    <button
      type="button"
      className={cn(pillClassName, className)}
      title={`Open details for Stage ${stageId}`}
      aria-label={`Open details for Stage ${stageId}`}
      onClick={() => openStage(stageId)}
    >
      S<b>{stageId}</b>
    </button>
  );
}

export interface StagePillItem {
  id: number;
}

// Cap on how many hidden pills a single overflow-button click reveals:
// exists because a real log flagged 939 distinct stages in one widget.
const OVERFLOW_REVEAL_CHUNK = 30;

export interface UseRevealMoreOptions {
  limit?: number;
  chunk?: number;
  dataset?: unknown;
}

export interface UseRevealMoreResult<T> {
  visible: T[];
  remaining: number;
  revealMore: () => void;
  revealThrough: (index: number) => void;
}

/** Generic first-N / reveal-more-in-chunks state, shared by `StagePillGroup`
 * and `CachingOpportunity`'s capped finding list (a different item shape). */
export function useRevealMore<T>(
  items: T[],
  { limit = VISIBLE_LIMIT, chunk = OVERFLOW_REVEAL_CHUNK, dataset = items }: UseRevealMoreOptions = {},
): UseRevealMoreResult<T> {
  const [revealState, setRevealState] = useState({ dataset, revealed: 0 });
  const datasetChanged = !Object.is(revealState.dataset, dataset);
  if (datasetChanged) setRevealState({ dataset, revealed: 0 });
  const revealed = datasetChanged ? 0 : revealState.revealed;
  const shownCount = limit + revealed;
  const visible = items.slice(0, shownCount);
  const remaining = Math.max(0, items.length - shownCount);
  const revealMore = () =>
    setRevealState((state) => ({
      dataset,
      revealed: (Object.is(state.dataset, dataset) ? state.revealed : 0) + chunk,
    }));
  // Reveals just enough extra items that `index` becomes visible: used by
  // route-target auto-jump (e.g. CachingOpportunity.tsx), which knows the
  // exact index it needs shown rather than "one more chunk". No-op (returns
  // the same state reference, so React bails without a re-render) if `index`
  // is already within the current window.
  const revealThrough = (index: number) =>
    setRevealState((state) => {
      const currentRevealed = Object.is(state.dataset, dataset) ? state.revealed : 0;
      const neededRevealed = Math.max(currentRevealed, index - limit + 1);
      return neededRevealed > currentRevealed ? { dataset, revealed: neededRevealed } : state;
    });
  return { visible, remaining, revealMore, revealThrough };
}

export interface StagePillGroupProps {
  pills: StagePillItem[];
  visibleLimit?: number;
  /** Applied to every rendered pill, including the "+N" overflow button: lets
   * a caller de-emphasize the group (e.g. HighestImpactBar's identity-first
   * layout, where the pills are secondary to the identity caption). */
  pillOverrideClassName?: string;
}

/** Row of stage pills: the first `visibleLimit` (default `VISIBLE_LIMIT`)
 * shown, the rest behind a "+N" button that reveals `OVERFLOW_REVEAL_CHUNK`
 * more per click. */
export function StagePillGroup({ pills, visibleLimit = VISIBLE_LIMIT, pillOverrideClassName }: StagePillGroupProps) {
  // A single stage can be flagged by several detectors at once (e.g. slowHost
  // emits one finding per slow host), so callers may pass the same id more than
  // once. Collapse to one pill per stage: the same stage rendered twice is
  // both redundant to the reader and a duplicate React key.
  const seen = new Set<number>();
  const uniquePills = pills.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));
  const dataset = JSON.stringify(uniquePills.map(({ id }) => id));
  const { visible: shown, remaining, revealMore } = useRevealMore(uniquePills, {
    limit: visibleLimit,
    dataset,
  });
  const hidden = uniquePills.slice(shown.length);

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {shown.map((pill) => (
        <StagePill key={pill.id} stageId={pill.id} className={pillOverrideClassName} />
      ))}
      {remaining > 0 && (
        <button
          type="button"
          className={cn(pillClassName, 'bg-muted', pillOverrideClassName)}
          title={`Also flagged: Stage ${hidden.map((p) => p.id).join(', Stage ')}`}
          aria-label={`Show ${remaining} more stage${remaining === 1 ? '' : 's'}`}
          onClick={revealMore}
        >
          +{remaining}
        </button>
      )}
    </div>
  );
}
