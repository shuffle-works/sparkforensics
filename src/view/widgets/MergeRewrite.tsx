import { memo, useMemo, useState } from 'react';

import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
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
import { stageIdOf } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useStatedAbove } from '@/view/InlineEvidenceContext';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export type MergeRewriteProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

// The counters behind a row: the finding text states the action only, so every row shows them.
function mergeMeasurement(finding: FindingOf<'mergeRewrite'>): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const { rewrittenRows, changedRows, filesBefore, filesAfter, partitionsScanned, partitionsTouched } = finding;
  const rows = `${n(rewrittenRows)} unmodified rows rewritten, ${n(changedRows)} rows inserted, updated or deleted.`;
  return filesBefore != null && filesAfter != null
    ? `${rows} Target files: ${n(filesBefore)} before skipping, ${n(filesAfter)} after.${partitionsScanned != null && partitionsTouched != null
      ? ` Partitions: ${n(partitionsScanned)} scanned, ${n(partitionsTouched)} changed.` : ''}`
    : rows;
}

function MergeRewriteRow({ finding }: { finding: FindingOf<'mergeRewrite'> }) {
  const anchor = useAnchoredRow([finding]);
  // The line above an evidence panel already shows the stage pills, the sentence and the savings.
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
      {stated ? null : (
        <p>
          {recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation} <ImpactEstimate finding={finding} />
        </p>
      )}
      <p className="text-xs text-muted-foreground">{mergeMeasurement(finding)}</p>
    </li>
  );
}

/** Board section for `mergeRewrite` findings: a MERGE that rewrote mostly unmodified rows or kept
 * most target files after skipping. Its siblings are `SmallFiles.tsx`, `NestedLoopJoin.tsx`,
 * `UnderBroadcast.tsx`, `OverBroadcast.tsx` and `DuplicatePlanSubtree.tsx`. */
export const MergeRewrite = memo(function MergeRewrite({ catalog, defaultCollapsed = true }: MergeRewriteProps) {
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const { findings, pills } = useMemo(() => {
    const findings = findingsOfType(catalog, 'mergeRewrite').sort(
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
      title="MERGE rewrites"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      open={cardOpen}
      onOpenChange={setCardOpen}
      badges={
        <>
          <TagBadge type="mergeRewrite" impactBand={worstImpactBand(findings) ?? 'info'} className={PLAN_TAG_CLASS} />
          {canToggleSort(findings, findings.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      statusBadge={
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
          <MergeRewriteRow key={f.id} finding={f} />
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
