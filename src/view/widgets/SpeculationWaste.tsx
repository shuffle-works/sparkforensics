import { memo, useState } from 'react';

import { formatDuration, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useAnchoredRow } from '@/view/finding-anchor';
import { canToggleSort } from '@/view/impact-sort';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';

export type SpeculationWasteProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

function metricLabel(f: Finding): string {
  return formatDuration(numericValue(f));
}

function IssueRow({ finding, appModel }: { finding: Finding; appModel: WidgetProps['appModel'] }) {
  const anchor = useAnchoredRow([finding]);
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-1 text-sm transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <ImpactDot impactBand={finding.impactBand} />
        {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} /> : null}
        <strong>{metricLabel(finding)}</strong>
      </div>
      <ImpactEstimate finding={finding} />
      <p className="text-muted-foreground pt-1">{finding.recommendation}</p>
    </li>
  );
}

/** Board section for `speculationWaste` findings: executor time spent on
 * speculative task attempts that were ultimately discarded. Split out of
 * the former combined `ExecutorTimeline.tsx`; see `SlowHost.tsx`,
 * `StageSlowness.tsx`, `Straggler.tsx`, and `ColdStart.tsx` for its four
 * siblings. */
export const SpeculationWaste = memo(function SpeculationWaste({ appModel, catalog, defaultCollapsed = true }: SpeculationWasteProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const issues = catalog
    .filter((f) => f.type === 'speculationWaste')
    .slice()
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);

  const orderedIssues = orderBy(issues, (f) => [f], (f) => f.stageId ?? null);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedIssues.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedIssues, page, setPage, routeIndex);

  if (issues.length === 0) return null;

  return (
    <WidgetCard
      title="Speculation Waste"
      impactBand={issues[0].impactBand}
      badges={
        <>
          <TagBadge type="speculationWaste" impactBand={issues[0].impactBand} />
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
          context={`${issues.length} issue${issues.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-2">{visible.map((f) => <IssueRow key={f.id} finding={f} appModel={appModel} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
