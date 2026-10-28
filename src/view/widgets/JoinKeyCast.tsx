import { memo, useMemo, useState } from 'react';

import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
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

export type JoinKeyCastProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

// The keys behind a row, for an evidence panel: the sentence above states the advice, not the keys.
function keyMeasurement(finding: FindingOf<'joinKeyCast'>): string {
  return `${finding.nodeName} on ${finding.castKeys.join(' and ')}; the next exchange shuffles by ${finding.exchangeKeys.join(', ')}.`;
}

function JoinKeyCastRow({ finding }: { finding: FindingOf<'joinKeyCast'> }) {
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
      {stated ? (
        <p className="text-xs text-muted-foreground">{keyMeasurement(finding)}</p>
      ) : (
        <p>
          {recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation} <ImpactEstimate finding={finding} />
        </p>
      )}
    </li>
  );
}

/** Board section for `joinKeyCast` findings: a shuffled join whose key carries a cast, followed by
 * an exchange on the uncast column. Its sibling is `NestedLoopJoin.tsx`. */
export const JoinKeyCast = memo(function JoinKeyCast({ catalog, defaultCollapsed = true }: JoinKeyCastProps) {
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  const { findings, pills } = useMemo(() => {
    const findings = findingsOfType(catalog, 'joinKeyCast').sort(
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
      title="Join Key Casts"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      open={cardOpen}
      onOpenChange={setCardOpen}
      badges={
        <>
          <TagBadge type="joinKeyCast" impactBand={worstImpactBand(findings) ?? 'info'} className={PLAN_TAG_CLASS} />
          {canToggleSort(findings, (f) => [f], stageIdOf, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
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
          <JoinKeyCastRow key={f.id} finding={f} />
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
