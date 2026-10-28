import { memo, useMemo, useState } from 'react';

import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { duplicateSubtreeDetail, duplicateSubtreeNote } from '@sparkforensics/core/finding-generic-recommendation.ts';
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
import { stageIdOf } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export type DuplicatePlanSubtreeProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

function DuplicatePlanSubtreeRow({ finding }: { finding: FindingOf<'duplicatePlanSubtree'> }) {
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
        {`${duplicateSubtreeDetail(finding)}.${duplicateSubtreeNote(finding)}`} <ImpactEstimate finding={finding} />
      </p>
    </li>
  );
}

/** Board section for `duplicatePlanSubtree` findings: a query plan that
 * repeats an identical subtree, wasting compute the planner could share. */
export const DuplicatePlanSubtree = memo(function DuplicatePlanSubtree({ catalog, defaultCollapsed = true }: DuplicatePlanSubtreeProps) {
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const { findings, pills, groupConfidence } = useMemo(() => {
    const findings = findingsOfType(catalog, 'duplicatePlanSubtree').sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
    );
    const pills = [...new Set(findings.flatMap((f) => f.stageIds))].map((id) => ({ id }));
    // Only claim a single header-level confidence when every finding in the
    // group actually shares it; a mixed group would otherwise show one
    // finding's confidence as if it applied to all of them.
    const groupConfidence = findings.every((f) => f.confidence === findings[0]?.confidence) ? findings[0] : undefined;
    return { findings, pills, groupConfidence };
  }, [catalog]);

  const orderedFindings = orderBy(findings, (f) => [f], stageIdOf);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedFindings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedFindings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Redundant Plan Subtree"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      open={cardOpen}
      onOpenChange={setCardOpen}
      badges={
        <>
          <TagBadge type="duplicatePlanSubtree" impactBand={worstImpactBand(findings) ?? 'info'} className={PLAN_TAG_CLASS} />
          {canToggleSort(findings, (f) => [f], stageIdOf, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      statusBadge={
        <AdvancedOnly>
          <RowStatusCluster
            confidence={groupConfidence?.confidence}
            validationRequired={groupConfidence?.validationRequired}
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
          <DuplicatePlanSubtreeRow key={f.id} finding={f} />
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
