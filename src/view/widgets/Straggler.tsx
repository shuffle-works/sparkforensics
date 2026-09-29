import { memo, useState } from 'react';

import { formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StageHeader } from '@/view/StageHeader';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import { useAnchoredRow } from '@/view/finding-anchor';
import type { StragglerFinding } from '@sparkforensics/core/finding-types.ts';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';

export type StragglerProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

// straggler reports whichever signal drove the finding: a speculative-retry
// count or a straggler-task percentage, distinguished by its `unit` field.
function stragglerDetail(f: StragglerFinding): string {
  const value = numericValue(f);
  return f.unit === 'count'
    ? `${value} speculative attempt${value === 1 ? '' : 's'} discarded`
    : `${formatMetricValue('pct', value)} of tasks straggled`;
}

function StragglerRow({ finding, appModel }: { finding: StragglerFinding; appModel: WidgetProps['appModel'] }) {
  const anchor = useAnchoredRow([finding]);
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-1 text-sm transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ImpactDot impactBand={finding.impactBand} />
          {finding.stageId != null ? <StageHeader stageId={finding.stageId} appModel={appModel} /> : null}
        </div>
        <AdvancedOnly>
          <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} />
        </AdvancedOnly>
      </div>
      <p className="text-xs text-muted-foreground">{stragglerDetail(finding)}</p>
      <ImpactEstimate finding={finding} />
    </li>
  );
}

/** Board section for `straggler` findings: a stage where speculative
 * retries fired or a share of tasks ran far longer than the median. Split
 * out of the former combined `ExecutorTimeline.tsx`; see `SlowHost.tsx`,
 * `StageSlowness.tsx`, `SpeculationWaste.tsx`, and `ColdStart.tsx` for its
 * four siblings. */
export const Straggler = memo(function Straggler({ appModel, catalog, defaultCollapsed = true }: StragglerProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const issues = findingsOfType(catalog, 'straggler')
    .slice()
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);

  const orderedIssues = orderBy(issues, (f) => [f], (f) => f.stageId ?? null);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedIssues.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedIssues, page, setPage, routeIndex);

  if (issues.length === 0) return null;

  return (
    <WidgetCard
      title="Stragglers"
      impactBand={issues[0].impactBand}
      fixFor={issues}
      badges={
        <>
          <TagBadge type="straggler" impactBand={issues[0].impactBand} />
          {canToggleSort(issues, issues.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={stragglerDetail(issues[0])}
          context={`${issues.length} issue${issues.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-2">{visible.map((f) => <StragglerRow key={f.id} finding={f} appModel={appModel} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
