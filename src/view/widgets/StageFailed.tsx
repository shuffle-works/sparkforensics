import { useEffect, useRef, useState } from 'react';

import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
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

export type StageFailedProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

function hasStage(f: Finding): f is Finding & { stageId: number } {
  // `stageId` is nullable on `Finding`; narrow once so `StagePill` needs no per-call-site cast.
  return f.stageId != null;
}

function StageFailedRow({ finding }: { finding: Finding & { stageId: number } }) {
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
        Stage attempt failed outright. Reason: <strong>{String(finding.value)}</strong>
      </p>
      <ImpactEstimate finding={finding} />
      {finding.recommendation ? <p className="text-xs text-muted-foreground">{finding.recommendation}</p> : null}
    </li>
  );
}

/** Board section for outright `stageFailed` attempts: every flagged stage
 * gets its own row (never just the worst). Split out of the combined
 * `Failures.tsx`; see `TaskFailures.tsx` and `RetryWaste.tsx` for its two
 * siblings. */
export function StageFailed({ appModel, catalog, defaultCollapsed = true }: StageFailedProps) {
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

  const findings = catalog.filter(hasStage).filter((f) => f.type === 'stageFailed');
  const sorted = [...findings].sort(
    (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || a.stageId - b.stageId,
  );
  const ordered = orderBy(sorted, (f) => [f], (f) => f.stageId);

  const routeIndex = activeRouteTarget ? ordered.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(ordered, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Failed Stages"
      impactBand={worstImpactBand(findings)}
      badges={
        <>
          <TagBadge type="stageFailed" impactBand={worstImpactBand(findings)!} />
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
          value={findings.length}
          context={`stage${findings.length === 1 ? '' : 's'} failed outright`}
        />
      }
    >
      <ul className="space-y-3">{visible.map((f) => <StageFailedRow key={f.id} finding={f} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
}
