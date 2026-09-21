import { memo, useMemo, useState } from 'react';
import { CircleCheck } from 'lucide-react';

import { Chip, ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { EmptyState } from '@/view/EmptyState';
import { StagePill } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { formatBytes, recommendPartitions, IMPACT_BAND_ORDER, numericValue, SPILL_CLASS_SHORT, SPILL_CLASS_TITLE } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { useWidgetDensity } from '@/store/store';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';

import { MemoryPressure } from './MemoryPressure';
import { PlanExplorer } from './PlanExplorer';
import { resolvePlanTree } from './PlanView';

type SpillClass = 'skew' | 'volume' | 'unclassified';

function classificationOf(appModel: WidgetProps['appModel'], stageId: number): SpillClass {
  const stage = appModel.stages.get(stageId);
  return stage?.spillClassification ?? 'unclassified';
}

/** One flagged stage's row, anchored so a triage route focuses the row itself.
 * `tabIndex={-1}` keeps it programmatically focusable without Tab order. */
function SpillRow({
  finding,
  appModel,
}: {
  finding: Finding & { stageId: number };
  appModel: WidgetProps['appModel'];
}) {
  const anchor = useAnchoredRow([finding]);
  const density = useWidgetDensity();
  const stage = appModel.stages.get(finding.stageId);
  const cls = classificationOf(appModel, finding.stageId);
  const partitionHint = cls === 'volume' && stage ? recommendPartitions(stage) : null;
  const showPlanExplorer = density === 'advanced' && resolvePlanTree(finding.stageId, appModel);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <ImpactDot impactBand={finding.impactBand} />
          <Chip label={SPILL_CLASS_SHORT[cls]} impactBand={finding.impactBand} title={SPILL_CLASS_TITLE[cls]} />
          <StagePill stageId={finding.stageId} />
        </div>
        <AdvancedOnly>
          <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} />
        </AdvancedOnly>
      </div>
      <p className="text-sm">
        {/* spill's value is always a numeric byte count. */}
        Memory spilled: <strong>{formatBytes(numericValue(finding))}</strong>
        {' · '}
        Disk: {formatBytes(stage?.diskBytesSpilled ?? 0)}
      </p>
      <ImpactEstimate finding={finding} />
      {partitionHint ? (
        <p className="text-xs text-muted-foreground">
          Try: <code>spark.sql.shuffle.partitions = {partitionHint.recommended}</code>
          {` (current ${partitionHint.current} tasks, target 128 MB per partition)`}
        </p>
      ) : null}
      {finding.recommendation ? <p className="text-xs text-muted-foreground">{finding.recommendation}</p> : null}
      {showPlanExplorer ? (
        <div className="pt-1">
          <PlanExplorer stageId={finding.stageId} appModel={appModel} />
        </div>
      ) : null}
    </div>
  );
}

/** Spill: memory/disk spill findings, one row per flagged stage, never just the
 * worst. The skew/volume/unclassified classification is the actionable signal,
 * so it's a plain-text label on every row (not a hover-only tooltip);
 * `SPILL_CLASS_TITLE` only supplies the supplementary `title=` tooltip. */
export const Spill = memo(function Spill({ appModel, catalog, defaultCollapsed = true }: WidgetProps) {
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  // Depends only on `catalog` and `sortMode`; memoized to skip recompute on
  // unrelated re-renders. Built unconditionally, before the "no issue" early
  // return, so hook order stays stable (rules of hooks).
  const { findings, sorted, orderedFindings } = useMemo(() => {
    const findings = catalog.filter(
      (f): f is Finding & { stageId: number } => f.type === 'spill' && f.stageId != null,
    );
    const sorted = [...findings].sort(
      (a, b) => (IMPACT_BAND_ORDER[a.impactBand] ?? 9) - (IMPACT_BAND_ORDER[b.impactBand] ?? 9)
        || (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0),
    );
    const orderedFindings = orderBy(sorted, (f) => [f], (f) => f.stageId);
    return { findings, sorted, orderedFindings };
  }, [catalog, sortMode]);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? orderedFindings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(orderedFindings, page, setPage, routeIndex);

  if (findings.length === 0) {
    let maxSpill = 0;
    for (const stage of appModel.stages.values()) {
      maxSpill = Math.max(maxSpill, stage.memoryBytesSpilled ?? 0);
    }
    return (
      <WidgetCard title={`Spill: no issue detected (max ${formatBytes(maxSpill)} spilled)`}>
        <EmptyState tone="clean" icon={CircleCheck} title="No stages spilled memory in this run." />
      </WidgetCard>
    );
  }

  const impactBand = sorted[0].impactBand;

  return (
    <WidgetCard
      title="Spill"
      impactBand={impactBand}
      badges={
        <>
          <TagBadge type="spill" impactBand={impactBand} />
          {canToggleSort(findings, sorted.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={formatBytes(typeof sorted[0].value === 'number' ? sorted[0].value : 0)}
          context={`peak · ${sorted.length} stage${sorted.length === 1 ? '' : 's'}`}
        />
      }
    >
      <div className="space-y-4">
        <MemoryPressure appModel={appModel} />
        {visible.map((f) => (
          <SpillRow key={f.stageId} finding={f} appModel={appModel} />
        ))}
        <RowPagination
          page={effectivePage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      </div>
    </WidgetCard>
  );
});
