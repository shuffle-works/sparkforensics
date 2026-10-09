import { memo, useMemo, useState } from 'react';

import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import type { WidgetProps } from '@/view/detector-registry';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { TagBadge } from '@/view/ImpactBadge';
import { StagePillGroup } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { canToggleSort, stageIdOf } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';
import { useWorstPresentedTone } from '@/view/impact-presentation';

export type NestedLoopJoinProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

/** One flagged finding's row, anchored so a triage route focuses the row
 * itself. `tabIndex={-1}` keeps it programmatically focusable without Tab order. */
function NestedLoopJoinRow({ finding }: { finding: FindingOf<'nestedLoopJoin'> }) {
  const anchor = useAnchoredRow([finding]);

  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      {finding.stageIds.length > 0 ? (
        <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} />
      ) : null}
      <p>
        {recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation} <ImpactEstimate finding={finding} />
      </p>
    </li>
  );
}

/** Board section for `nestedLoopJoin` findings: a BroadcastNestedLoopJoin or CartesianProduct
 * whose output rows are far above both inputs. Its siblings are `SmallFiles.tsx`,
 * `UnderBroadcast.tsx`, `OverBroadcast.tsx` and `DuplicatePlanSubtree.tsx`. */
export const NestedLoopJoin = memo(function NestedLoopJoin({ catalog, defaultCollapsed = true }: NestedLoopJoinProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const { findings, pills } = useMemo(() => {
    const findings = findingsOfType(catalog, 'nestedLoopJoin').sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
    );
    const pills = [...new Set(findings.flatMap((f) => f.stageIds))].map((id) => ({ id }));
    return { findings, pills };
  }, [catalog, sortMode]);

  const orderedFindings = orderBy(findings, (f) => [f], stageIdOf);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedFindings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedFindings, page, setPage, routeIndex);

  const worstTone = useWorstPresentedTone(findings);
  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Nested Loop Joins"
      fixFor={findings}
      impactBand={worstTone}
      open={cardOpen}
      onOpenChange={setCardOpen}
      badges={
        <>
          <TagBadge type="nestedLoopJoin" impactBand={worstTone ?? 'info'} className={PLAN_TAG_CLASS} />
          {canToggleSort(findings, findings.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      statusBadge={
        // `sqlPlan` is a widget-wide evidence constant (this detector always reads
        // the resolved SQL plan), so it sits on the header once, not per row.
        <AdvancedOnly>
          <RowStatusCluster
            confidence={findings[0].confidence}
            validationRequired={findings[0].validationRequired}
            evidenceKey="sqlPlan"
          />
        </AdvancedOnly>
      }
      summary={
        <WidgetLeadSummary
          value={`${pills.length} stage${pills.length === 1 ? '' : 's'}`}
          context={findingCount(findings.length)}
        />
      }
    >
      <ul className="space-y-3 text-sm">
        {visible.map((f) => (
          <NestedLoopJoinRow key={f.id} finding={f} />
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
