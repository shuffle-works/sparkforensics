import { memo, useState } from 'react';

import { formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import { useAnchoredRow } from '@/view/finding-anchor';
import type { SlowHostFinding } from '@/view/slow-host-straggler-finding';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';

export type SlowHostProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

// slowHost reports one of three unrelated sub-signals under the same finding
// type, each with its own unit: a per-host mean-duration ratio, a per-host
// share of the stage's total task time, or a per-executor deviation on a
// secondary dimension (with no `host`). Each needs its own sentence.
function slowHostDetail(f: SlowHostFinding): string {
  const value = numericValue(f);
  if (f.metric === 'execMaxMedianRatio') {
    return `Executor ${f.executorId}: ${formatMetricValue('ratio', value)} median on ${f.dimension ?? 'this metric'}`;
  }
  const taskSharePct = Math.round((f.hostTaskShare ?? 0) * 100);
  if (f.metric === 'hostDurationShare') {
    return `${f.host}: ${formatMetricValue('pctFraction', value)} of this stage's task time (${formatMetricValue('pct', taskSharePct)} of tasks)`;
  }
  return `${f.host}: ${formatMetricValue('ratio', value)} median task time (${formatMetricValue('pct', taskSharePct)} of tasks)`;
}

// hostDurationShare/execMaxMedianRatio recommendations restate slowHostDetail's
// host/ratio/dimension figures before a colon, then the real advice; strip that
// redundant clause so the detail line extends into the advice instead of
// repeating it. Always visible, same as hostMeanRatio's recommendation below,
// which has no such restatement and so returns null here and stays fully
// visible unconditionally via its own paragraph.
function slowHostAdvice(f: SlowHostFinding): string | null {
  if (f.metric !== 'hostDurationShare' && f.metric !== 'execMaxMedianRatio') return null;
  const recommendation = f.recommendation ?? '';
  const adviceStart = recommendation.indexOf(': ');
  return adviceStart === -1 ? null : recommendation.slice(adviceStart);
}

function SlowHostRow({ finding, appModel }: { finding: SlowHostFinding; appModel: WidgetProps['appModel'] }) {
  const anchor = useAnchoredRow([finding]);
  const advice = slowHostAdvice(finding);
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
      </div>
      <p className="text-xs text-muted-foreground">
        {slowHostDetail(finding)}
        {advice}
      </p>
      <ImpactEstimate finding={finding} />
      {advice == null ? <p className="text-muted-foreground pt-1">{finding.recommendation}</p> : null}
    </li>
  );
}

/** Board section for `slowHost` findings: a host or executor doing
 * disproportionate work within a stage. Split out of the former combined
 * `ExecutorTimeline.tsx`; see `StageSlowness.tsx`, `Straggler.tsx`,
 * `SpeculationWaste.tsx`, and `ColdStart.tsx` for its four siblings, and
 * `ExecutorCountChart.tsx` for the whole-run chart this file used to also
 * render. */
export const SlowHost = memo(function SlowHost({ appModel, catalog, defaultCollapsed = true }: SlowHostProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const issues = (catalog.filter((f) => f.type === 'slowHost') as SlowHostFinding[])
    .slice()
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);

  const orderedIssues = orderBy(issues, (f) => [f], (f) => f.stageId ?? null);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedIssues.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedIssues, page, setPage, routeIndex);

  if (issues.length === 0) return null;

  return (
    <WidgetCard
      title="Slow Executor Host"
      impactBand={issues[0].impactBand}
      badges={
        <>
          <TagBadge type="slowHost" impactBand={issues[0].impactBand} />
          {canToggleSort(issues, issues.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={slowHostDetail(issues[0])}
          context={`${issues.length} issue${issues.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-2">
        {visible.map((f) => (
          <SlowHostRow
            key={f.id}
            finding={f}
            appModel={appModel}
          />
        ))}
      </ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
