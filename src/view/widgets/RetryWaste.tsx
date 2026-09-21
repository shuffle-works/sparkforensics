import { useEffect, useRef, useState } from 'react';

import { IMPACT_BAND_ORDER, formatDuration, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
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

export type RetryWasteProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

function hasStage(f: Finding): f is Finding & { stageId: number } {
  return f.stageId != null;
}

// `extended`'s first sentence restates the same duration the detail line
// above already shows; strip that redundant clause so Advanced tier extends
// the detail line instead of repeating it.
function retryWasteAdvancedExtension(f: Finding): string {
  const extended = String(f.extended ?? '');
  return extended.replace(/, wasting \d+s of executor time\./, '.');
}

// `recommendation` restates the same wasted-time figure the stat line above
// already shows, then a colon, then the actual advice; keep just the advice
// half, always visible (unlike `extended`'s causes/cross-reference, this is
// the one thing a Basic-tier reader needs to act on the finding).
function retryWasteAction(f: Finding): string {
  const recommendation = String(f.recommendation ?? '');
  const adviceStart = recommendation.indexOf(': ');
  return adviceStart === -1 ? recommendation : recommendation.slice(adviceStart + 2);
}

function RetryWasteRow({ finding }: { finding: Finding & { stageId: number } }) {
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
        Wasted <strong>{formatDuration(numericValue(finding))}</strong> of executor time.
        {finding.extended ? <AdvancedOnly> {retryWasteAdvancedExtension(finding)}</AdvancedOnly> : null}
      </p>
      {finding.recommendation ? <p className="text-xs text-muted-foreground">{retryWasteAction(finding)}</p> : null}
      <ImpactEstimate finding={finding} />
    </li>
  );
}

/** Board section for `retryWaste` findings: retried task attempts that
 * wasted executor time even though the stage ultimately completed. Split
 * out of the former combined `Failures.tsx`; see `StageFailed.tsx` and
 * `TaskFailures.tsx` for its two siblings. */
export function RetryWaste({ appModel, catalog, defaultCollapsed = true }: RetryWasteProps) {
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

  const findings = catalog.filter(hasStage).filter((f) => f.type === 'retryWaste');
  const sorted = [...findings].sort(
    (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]
      || (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0),
  );
  const ordered = orderBy(sorted, (f) => [f], (f) => f.stageId);

  const routeIndex = activeRouteTarget ? ordered.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(ordered, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Retry Waste"
      impactBand={worstImpactBand(findings)}
      badges={
        <>
          <TagBadge type="retryWaste" impactBand={worstImpactBand(findings)!} />
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
          value={formatDuration(numericValue(sorted[0]))}
          context={`${findings.length} item${findings.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-3">{visible.map((f) => <RetryWasteRow key={f.id} finding={f} />)}</ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
}
