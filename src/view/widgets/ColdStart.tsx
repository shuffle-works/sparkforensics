import { memo, useState } from 'react';

import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useAnchoredRow } from '@/view/finding-anchor';
import { canToggleSort } from '@/view/impact-sort';
import { usePresentedTone, usePresentedToneOf } from '@/view/impact-presentation';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';

export type ColdStartProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

// The row shows the measured wait; the card states the fix once.
function metricLabel(f: Finding): string {
  return `${f.value}s`;
}

function IssueRow({ finding }: { finding: Finding }) {
  const anchor = useAnchoredRow([finding]);
  const tone = usePresentedTone(finding);
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-1 text-sm transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ImpactDot impactBand={tone} />
        <strong>{metricLabel(finding)}</strong>
      </div>
      <ImpactEstimate finding={finding} />
    </li>
  );
}

/** Board section for `coldStart` findings: the gap between app start and
 * the first stage submission. App-scoped (`stageId` is always `null`).
 * Split out of the former combined `ExecutorTimeline.tsx`; see
 * `SlowHost.tsx`, `StageSlowness.tsx`, `Straggler.tsx`, and
 * `SpeculationWaste.tsx` for its four siblings. */
export const ColdStart = memo(function ColdStart({ catalog, defaultCollapsed = true }: ColdStartProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const issues = catalog
    .filter((f) => f.type === 'coldStart')
    .slice()
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);

  const orderedIssues = orderBy(issues, (f) => [f], (f) => f.stageId ?? null);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedIssues.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedIssues, page, setPage, routeIndex);

  const toneOf = usePresentedToneOf();

  if (issues.length === 0) return null;

  return (
    <WidgetCard
      title="Cold Start"
      fixFor={issues}
      impactBand={toneOf(issues[0])}
      badges={
        <>
          <TagBadge type="coldStart" impactBand={toneOf(issues[0])} />
          {canToggleSort(issues, issues.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={metricLabel(issues[0])}
          context={findingCount(issues.length)}
        />
      }
    >
      <ul className="space-y-2">{visible.map((f) => <IssueRow key={f.id} finding={f} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
