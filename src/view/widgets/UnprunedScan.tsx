import { memo, useMemo, useState } from 'react';

import { formatBytes, IMPACT_BAND_ORDER, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import type { WidgetProps } from '@/view/detector-registry';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { TagBadge } from '@/view/ImpactBadge';
import { StagePillGroup } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { stageIdOf } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useStatedAbove } from '@/view/InlineEvidenceContext';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export type UnprunedScanProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

function UnprunedScanRow({ finding }: { finding: FindingOf<'unprunedScan'> }) {
  const anchor = useAnchoredRow([finding]);
  // The line above an evidence panel already shows the stage pills and the sentence.
  const stated = useStatedAbove(finding);

  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      {!stated && finding.stageIds.length > 0 ? (
        <StagePillGroup pills={finding.stageIds.map((id) => ({ id }))} />
      ) : null}
      <p>
        <span className="font-medium">{finding.relation}</span>
        {' '}
        <span className="text-muted-foreground">
          read {formatBytes(numericValue(finding))} from {finding.partitionsRead} partitions, filtered on {finding.dataFilters.join(', ')}
        </span>
      </p>
      {stated ? null : <p>{recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation}</p>}
    </li>
  );
}

/** Board section for `unprunedScan` findings: a filtered scan of a partitioned
 * table with no partition filter. */
export const UnprunedScan = memo(function UnprunedScan({ catalog, defaultCollapsed = true }: UnprunedScanProps) {
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const { findings, pills } = useMemo(() => {
    const findings = findingsOfType(catalog, 'unprunedScan').sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
    );
    const pills = [...new Set(findings.flatMap((f) => f.stageIds))].map((id) => ({ id }));
    return { findings, pills };
  }, [catalog, sortMode]);

  const orderedFindings = orderBy(findings, (f) => [f], stageIdOf);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedFindings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedFindings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Unpruned Partitioned Scan"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      open={cardOpen}
      onOpenChange={setCardOpen}
      badges={
        <>
          <TagBadge type="unprunedScan" impactBand={worstImpactBand(findings) ?? 'info'} className={PLAN_TAG_CLASS} />
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
          <UnprunedScanRow key={f.id} finding={f} />
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
