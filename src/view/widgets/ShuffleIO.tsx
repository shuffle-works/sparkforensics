import { memo, useMemo, useState } from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { TagBadge } from '@/view/ImpactBadge';
import { StagePillGroup } from '@/view/StagePill';
import { StageHeader } from '@/view/StageHeader';
import { formatBytes, recommendPartitions, IMPACT_BAND_ORDER, numericValue, VISIBLE_LIMIT, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
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
  shuffle: Finding;
  impactBand: ImpactBand;
  peak: number;
}

function ShuffleRow({ entry, appModel }: { entry: StageEntry; appModel: WidgetProps['appModel'] }) {
  const density = useWidgetDensity();
  const anchor = useAnchoredRow([entry.shuffle]);
  const stage = appModel.stages.get(entry.stageId);
  const partitionHint = stage ? recommendPartitions(stage) : null;
  const showPlanExplorer = density === 'advanced' && resolvePlanTree(entry.stageId, appModel);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <StageHeader stageId={entry.stageId} appModel={appModel} />
      <p className="text-sm">
        Shuffle read: <strong>{formatBytes(numericValue(entry.shuffle))}</strong>
        {' · '}
        Write: {formatBytes(stage?.shuffleWriteBytes ?? 0)}
      </p>
      <ImpactEstimate finding={entry.shuffle} />
      {partitionHint || showPlanExplorer ? (
        <div className="space-y-2 pt-1">
          {partitionHint ? (
            <p className="text-xs text-muted-foreground">
              Try <code>spark.sql.shuffle.partitions = {partitionHint.recommended}</code>: current{' '}
              {partitionHint.current} tasks, target 128 MB per partition
            </p>
          ) : null}
          {showPlanExplorer ? <PlanExplorer stageId={entry.stageId} appModel={appModel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/** Shuffle read/write board. Serves the `shuffle` detector type only; see
 * `PartitionSizing.tsx` for the sibling partition-sizing widget this file
 * used to also render. */
export const ShuffleIO = memo(function ShuffleIO({ appModel, catalog, defaultCollapsed = true }: WidgetProps) {
  const [page, setPage] = useState(0);
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const activeRouteTarget = useActiveRouteTarget();

  const { shuffleFindings, sorted, orderedEntries } = useMemo(() => {
    const shuffleFindings = catalog.filter((f) => f.type === 'shuffle');
    const entries: StageEntry[] = shuffleFindings
      .filter((f) => f.stageId != null)
      .map((f) => ({ stageId: f.stageId as StageId, shuffle: f, impactBand: f.impactBand, peak: numericValue(f) }));

    const sorted = [...entries].sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || b.peak - a.peak,
    );
    const orderedEntries = orderBy(sorted, (e) => [e.shuffle], (e) => e.stageId);

    return { shuffleFindings, sorted, orderedEntries };
  }, [catalog, sortMode]);

  const routeIndex = activeRouteTarget
    ? orderedEntries.findIndex((entry) => entry.shuffle === activeRouteTarget.finding)
    : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedEntries, page, setPage, routeIndex);

  if (shuffleFindings.length === 0) {
    let maxRead = 0;
    for (const stage of appModel.stages.values()) {
      maxRead = Math.max(maxRead, stage.shuffleReadBytes ?? 0);
    }
    return (
      <WidgetCard
        title="Shuffle I/O"
        open={cardOpen}
        onOpenChange={setCardOpen}
        summary={<WidgetLeadSummary value={formatBytes(maxRead)} context="no issue detected: peak shuffle read" />}
      >
        <div className="flex flex-col gap-1">
          <p className="text-xs text-muted-foreground">No shuffle read/write issues detected.</p>
        </div>
      </WidgetCard>
    );
  }

  const combinedImpactBand = worstImpactBand(shuffleFindings);
  const pills = orderedEntries.map((e) => ({ id: e.stageId }));
  const canSortByImpact = canToggleSort(shuffleFindings, sorted.length, cardOpen);

  return (
    <WidgetCard
      title="Shuffle I/O"
      impactBand={combinedImpactBand}
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={formatBytes(sorted[0].peak)}
          context={`Peak shuffle read · ${sorted.length} stage${sorted.length === 1 ? '' : 's'} flagged`}
        />
      }
      badges={
        <>
          <TagBadge type="shuffle" impactBand={combinedImpactBand ?? 'info'} />
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
        <StagePillGroup pills={pills} />
        {visible.map((entry) => (
          <ShuffleRow key={entry.stageId} entry={entry} appModel={appModel} />
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
                    Stage {entry.stageId} ({formatBytes(entry.peak)})
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
