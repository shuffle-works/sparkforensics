import { memo, useMemo, useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { TagBadge } from '@/view/ImpactBadge';
import { StageHeader } from '@/view/StageHeader';
import { formatBytes, numericValue, IMPACT_BAND_ORDER, VISIBLE_LIMIT, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding, ImpactBand, StageId } from '@sparkforensics/core/types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { useWidgetDensity } from '@/store/store';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import { PlanExplorer } from './PlanExplorer';
import { resolvePlanTree } from './PlanView';

interface StageEntry {
  stageId: StageId;
  partitions: Finding[];
  impactBand: ImpactBand;
}

/** `partitionSizing`'s three rules each report a different metric under one
 * finding type; render `value` as a short label per rule. */
function partitionSizingLabel(f: Finding): string {
  if (f.rule === 'lowShuffleParallelism') return `${numericValue(f)} tasks carrying the shuffle`;
  const bytes = numericValue(f);
  return f.rule === 'maxPartitionTooBig' ? `Largest partition ${formatBytes(bytes)} (too large)` : `Largest partition ${formatBytes(bytes)}`;
}

function PartitionSizingRow({ entry, appModel }: { entry: StageEntry; appModel: WidgetProps['appModel'] }) {
  const density = useWidgetDensity();
  const anchor = useAnchoredRow(entry.partitions);
  const showPlanExplorer = density === 'advanced' && resolvePlanTree(entry.stageId, appModel);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <StageHeader stageId={entry.stageId} appModel={appModel} />
      <p className="text-xs text-muted-foreground">
        {entry.partitions.map((f, i) => (
          <span key={f.id}>
            {i > 0 ? ' · ' : ''}
            {partitionSizingLabel(f)}
          </span>
        ))}
      </p>
      <ImpactEstimate finding={entry.partitions[0]} />
      <div className="space-y-2 pt-1">
        <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
          {entry.partitions.map((f) => (
            <li key={f.id}>
              {f.recommendation}{' '}
              <ImpactEstimate finding={f} />
            </li>
          ))}
        </ul>
        {showPlanExplorer ? <PlanExplorer stageId={entry.stageId} appModel={appModel} /> : null}
      </div>
    </div>
  );
}

export type PartitionSizingProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'defaultCollapsed'>;

/** Partition-sizing recommendations board: flags every stage carrying a
 * `partitionSizing` finding (never just the worst one). Split out of the
 * former combined `ShuffleIO.tsx`; see that file for the sibling `shuffle`
 * widget. */
export const PartitionSizing = memo(function PartitionSizing({ appModel, catalog, defaultCollapsed = true }: PartitionSizingProps) {
  const [page, setPage] = useState(0);
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const activeRouteTarget = useActiveRouteTarget();

  const { partitionFindings, sorted, orderedEntries } = useMemo(() => {
    const partitionFindings = catalog.filter((f) => f.type === 'partitionSizing');

    const entries = new Map<StageId, StageEntry>();
    for (const f of partitionFindings) {
      if (f.stageId == null) continue;
      const existing = entries.get(f.stageId);
      if (existing) {
        existing.partitions.push(f);
        if (IMPACT_BAND_ORDER[f.impactBand] < IMPACT_BAND_ORDER[existing.impactBand]) existing.impactBand = f.impactBand;
      } else {
        entries.set(f.stageId, { stageId: f.stageId, partitions: [f], impactBand: f.impactBand });
      }
    }

    const sorted = [...entries.values()].sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || a.stageId - b.stageId,
    );
    const orderedEntries = orderBy(sorted, (e) => e.partitions, (e) => e.stageId);

    return { partitionFindings, sorted, orderedEntries };
  }, [catalog, sortMode]);

  const routeIndex = activeRouteTarget
    ? orderedEntries.findIndex((entry) => entry.partitions.includes(activeRouteTarget.finding))
    : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedEntries, page, setPage, routeIndex);

  if (partitionFindings.length === 0) {
    const stageCount = appModel.stages.size;
    return (
      <WidgetCard
        title="Partition Sizing"
        open={cardOpen}
        onOpenChange={setCardOpen}
        summary={
          <WidgetLeadSummary
            value="No issues"
            context={`no issue detected: partition sizing checked across ${stageCount} stage${stageCount === 1 ? '' : 's'}`}
          />
        }
      >
        <p className="text-xs text-muted-foreground">No partition-sizing issues detected.</p>
      </WidgetCard>
    );
  }

  const combinedImpactBand = worstImpactBand(partitionFindings);
  const canSortByImpact = canToggleSort(partitionFindings, sorted.length, cardOpen);

  return (
    <WidgetCard
      title="Partition Sizing"
      impactBand={combinedImpactBand}
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={`Stage ${sorted[0].stageId}`}
          context={`${sorted.length} stage${sorted.length === 1 ? '' : 's'} flagged`}
        />
      }
      badges={
        <>
          <TagBadge type="partitionSizing" impactBand={combinedImpactBand ?? 'info'} />
          {canSortByImpact ? (
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
    >
      <div className="space-y-4">
        {visible.map((entry) => (
          <PartitionSizingRow key={entry.stageId} entry={entry} appModel={appModel} />
        ))}
        <RowPagination
          page={effectivePage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
          renderJumpControl={() => (
            <Select
              value={String(effectivePage * VISIBLE_LIMIT)}
              onValueChange={(value) => setPage(Math.floor(Number(value) / VISIBLE_LIMIT))}
            >
              <SelectTrigger size="sm" aria-label="Jump to stage">
                <SelectValue placeholder="Jump to stage" />
              </SelectTrigger>
              <SelectContent>
                {orderedEntries.map((entry, i) => (
                  <SelectItem key={entry.stageId} value={String(i)}>
                    Stage {entry.stageId}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        />
      </div>
    </WidgetCard>
  );
});
