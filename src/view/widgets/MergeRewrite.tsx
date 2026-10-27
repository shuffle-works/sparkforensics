import { memo, useMemo, useState } from 'react';

import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
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
import { useAnyStatedAbove } from '@/view/InlineEvidenceContext';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export type MergeRewriteProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

type MergeFinding = FindingOf<'mergeRewrite'>;

// MERGE commands whose counters are identical share one row. A MERGE that trips both rules has two
// findings with the same counters, so `executionIds` counts each command once.
interface MergeRowGroup {
  findings: MergeFinding[];
  executionIds: number[];
  targets: (string | null)[];
}

function groupByCounters(findings: MergeFinding[]): MergeRowGroup[] {
  const groups = new Map<string, MergeRowGroup>();
  for (const f of findings) {
    const key = JSON.stringify([f.rewrittenRows, f.changedRows, f.filesBefore, f.filesAfter, f.partitionsScanned, f.partitionsTouched]);
    const group = groups.get(key) ?? { findings: [], executionIds: [], targets: [] };
    group.findings.push(f);
    if (!group.executionIds.includes(f.executionId)) {
      group.executionIds.push(f.executionId);
      group.targets.push(f.target);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function listQueries(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b).map(String);
  return sorted.length < 2 ? sorted.join('') : `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

// Names the MERGE by its SQL query number, and by its target when the log names one for all of them.
function rowLabel({ executionIds, targets }: MergeRowGroup): string {
  const target = targets.every((t) => t === targets[0]) ? targets[0] : null;
  const on = target ? ` on ${target}` : '';
  return executionIds.length === 1
    ? `MERGE query ${executionIds[0]}${on}`
    : `${executionIds.length} MERGE commands (queries ${listQueries(executionIds)})${on}`;
}

function mergeMeasurement(finding: MergeFinding): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const { rewrittenRows, changedRows, filesBefore, filesAfter, partitionsScanned, partitionsTouched } = finding;
  const rows = `${n(rewrittenRows)} unmodified rows rewritten, ${n(changedRows)} rows inserted, updated or deleted.`;
  return filesBefore != null && filesAfter != null
    ? `${rows} Target files: ${n(filesBefore)} before skipping, ${n(filesAfter)} after.${partitionsScanned != null && partitionsTouched != null
      ? ` Partitions: ${n(partitionsScanned)} scanned, ${n(partitionsTouched)} changed.` : ''}`
    : rows;
}

function MergeRewriteRow({ group }: { group: MergeRowGroup }) {
  const anchor = useAnchoredRow(group.findings);
  // The line above an evidence panel already shows the stage pills.
  const stated = useAnyStatedAbove(group.findings);
  const stageIds = [...new Set(group.findings.flatMap((f) => f.stageIds))].sort((a, b) => a - b);

  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      {!stated && stageIds.length > 0 ? <StagePillGroup pills={stageIds.map((id) => ({ id }))} /> : null}
      <p>
        <span className="font-medium">{rowLabel(group)}</span>
        {' '}
        <span className="text-muted-foreground">{mergeMeasurement(group.findings[0])}</span>
        {' '}
        <ImpactEstimate finding={group.findings[0]} />
      </p>
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

  const { findings, groups } = useMemo(() => {
    const findings = findingsOfType(catalog, 'mergeRewrite').sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
    );
    return { findings, groups: groupByCounters(findings) };
  }, [catalog, sortMode]);

  const orderedGroups = orderBy(groups, (g) => g.findings, (g) => stageIdOf(g.findings[0]));
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedGroups.findIndex((g) => g.findings.includes(activeRouteTarget.finding as MergeFinding)) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedGroups, page, setPage, routeIndex);
  // Stage order only means something when a row has a stage.
  const hasStages = findings.some((f) => f.stageIds.length > 0);
  const commandCount = new Set(findings.map((f) => f.executionId)).size;

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
          {hasStages && canToggleSort(findings, groups.length, cardOpen) ? (
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
          value={`${commandCount} MERGE command${commandCount === 1 ? '' : 's'}`}
          context={findingCount(findings.length)}
        />
      }
    >
      <ul className="space-y-3 text-sm">
        {visible.map((g) => (
          <MergeRewriteRow key={g.findings[0].id} group={g} />
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
