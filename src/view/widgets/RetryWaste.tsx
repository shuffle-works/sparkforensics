import { useEffect, useRef, useState } from 'react';

import { IMPACT_BAND_ORDER, formatDuration, numericValue } from '@sparkforensics/core/format-utils.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { StagePill } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { Finding, FindingOf } from '@sparkforensics/core/types.ts';
import { useAnchoredRow } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import { usePresentedTone, useWorstPresentedTone } from '@/view/impact-presentation';

export type RetryWasteProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

function hasStage<F extends Finding>(f: F): f is F & { stageId: number } {
  return f.stageId != null;
}

// `extended`'s first sentence restates the same duration the detail line
// above already shows; strip that redundant clause so Advanced tier extends
// the detail line instead of repeating it.
function retryWasteAdvancedExtension(f: FindingOf<'retryWaste'>): string {
  const extended = f.extended ?? '';
  return extended.replace(/, wasting \d+s of executor time\./, '.');
}

function RetryWasteRow({ finding }: { finding: FindingOf<'retryWaste'> & { stageId: number } }) {
  const anchor = useAnchoredRow([finding]);
  const tone = usePresentedTone(finding);
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`flex flex-col gap-1 transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex items-center gap-2">
        <StagePill stageId={finding.stageId} />
        <ImpactDot impactBand={tone} />
      </div>
      <p className="text-xs text-muted-foreground">
        Wasted <strong>{formatDuration(numericValue(finding))}</strong> of executor time.
        {finding.extended ? <AdvancedOnly> {retryWasteAdvancedExtension(finding)}</AdvancedOnly> : null}
      </p>
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

  const findings = findingsOfType(catalog, 'retryWaste').filter(hasStage);
  const sorted = [...findings].sort(
    (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]
      || (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0),
  );
  const ordered = orderBy(sorted, (f) => [f], (f) => f.stageId);

  const routeIndex = activeRouteTarget ? ordered.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(ordered, page, setPage, routeIndex);

  const worstTone = useWorstPresentedTone(findings);
  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Retry Waste"
      fixFor={findings}
      impactBand={worstTone}
      badges={
        <>
          <TagBadge type="retryWaste" impactBand={worstTone!} />
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
          context={findingCount(findings.length)}
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
