import { useEffect, useRef, useState } from 'react';

import { IMPACT_BAND_ORDER, formatMetricValue, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { StagePill } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { useAnchoredRow } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';

export type TaskFailuresProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

function hasStage(f: Finding): f is Finding & { stageId: number } {
  return f.stageId != null;
}

function TaskFailureRow({ finding }: { finding: Finding & { stageId: number } }) {
  const anchor = useAnchoredRow([finding]);
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`flex flex-col gap-1 transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex items-center gap-2">
        <StagePill stageId={finding.stageId} />
        <ImpactDot impactBand={finding.impactBand} />
      </div>
      <p className="text-xs text-muted-foreground">
        Failure rate: <strong>{finding.value}%</strong> ({String(finding.failedTasks)} tasks) &middot; Dominant
        reason: <strong>{(finding.dominantReason as string | null | undefined) ?? '—'}</strong>
      </p>
      <ImpactEstimate finding={finding} />
      {finding.recommendation ? <p className="text-xs text-muted-foreground">{finding.recommendation}</p> : null}
    </li>
  );
}

/** Board section for task-level `failures` findings: every flagged stage
 * gets its own row (never just the worst). Split out of the former combined
 * `Failures.tsx`; see `StageFailed.tsx` and `RetryWaste.tsx` for its two
 * siblings. */
export function TaskFailures({ appModel, catalog, defaultCollapsed = true }: TaskFailuresProps) {
  const [page, setPage] = useState(0);
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const activeRouteTarget = useActiveRouteTarget();

  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setPage(0);
  }, [appModel]);

  const findings = catalog.filter(hasStage).filter((f) => f.type === 'failures');
  const sorted = [...findings].sort(
    (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || a.stageId - b.stageId,
  );
  const ordered = orderBy(sorted, (f) => [f], (f) => f.stageId);

  const routeIndex = activeRouteTarget ? ordered.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(ordered, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Failed Tasks"
      impactBand={worstImpactBand(findings)}
      badges={
        <>
          <TagBadge type="failures" impactBand={worstImpactBand(findings)!} />
          {canToggleSort(findings, findings.length, cardOpen) ? (
            <SortModeToggle
              mode={sortMode}
              onChange={(next) => {
                setSortMode(next);
                setPage(0);
              }}
            />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={formatMetricValue('pct', numericValue(sorted[0]))}
          context={`${findings.length} item${findings.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-3">{visible.map((f) => <TaskFailureRow key={f.id} finding={f} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
}
