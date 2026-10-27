import { memo, useMemo, useState } from 'react';
import { CircleCheck } from 'lucide-react';

import { Chip, ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { useStatedAbove } from '@/view/InlineEvidenceContext';
import { EmptyState } from '@/view/EmptyState';
import { StagePill } from '@/view/StagePill';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { describeSpillRatio, formatBytes, formatRowWidth, recommendPartitions, IMPACT_BAND_ORDER, numericValue, SPILL_CLASS_SHORT, SPILL_CLASS_TITLE } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding, FindingOf } from '@sparkforensics/core/types.ts';
import type { SpillExchange } from '@sparkforensics/core/finding-types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { useWidgetDensity } from '@/store/store';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { RowPagination } from '@/view/RowPagination';

import { MemoryPressure } from './MemoryPressure';
import { PartitionHint } from './PartitionHint';
import { PlanExplorer } from './PlanExplorer';
import { resolvePlanTree } from './PlanView';

type SpillClass = 'skew' | 'volume' | 'unclassified';

function classificationOf(appModel: WidgetProps['appModel'], stageId: number): SpillClass {
  const stage = appModel.stages.get(stageId);
  return stage?.spillClassification ?? 'unclassified';
}

// `hashpartitioning(k#1, 200), 200 partitions, REPARTITION_BY_NUM`, as far as the plan gave it.
function formatExchangeArguments({ partitioning, partitions, origin }: SpillExchange): string {
  return [partitioning, partitions !== undefined ? `${partitions} partitions` : undefined, origin].filter(Boolean).join(', ');
}

/** Where the stage's spill sits: the operators that spilled with their arguments, the spill-to-input
 * ratio, the width and partitioning of the rows they read, and the SQL execution's description.
 * `stated`: the line above an evidence panel already carries the operators' spill and the ratio. */
function SpillEvidence({ finding, stated }: { finding: FindingOf<'spill'>; stated: boolean }) {
  const { operators = [], exchanges = [], spillToInputRatio, wideRows = false, reads, sqlDescription } = finding;
  if (operators.length === 0 && exchanges.length === 0 && spillToInputRatio === undefined && !sqlDescription) return null;
  const widths = exchanges.map(formatRowWidth).filter(Boolean);
  const partitioned = exchanges.filter((ex) => ex.partitioning);
  if (stated && !operators.some((op) => op.arguments) && widths.length === 0 && partitioned.length === 0 && !sqlDescription) return null;
  return (
    <ul className="space-y-0.5 text-sm text-muted-foreground">
      {!stated && operators.length > 0 ? (
        <li>
          Spilled by{' '}
          {operators.map((op) => `${op.name}${op.feeds ? ` (feeds ${op.feeds})` : ''} ${formatBytes(op.spillBytes)}`).join(', ')}
        </li>
      ) : null}
      {!stated && spillToInputRatio !== undefined ? <li>{describeSpillRatio(spillToInputRatio, wideRows, reads === 'input', exchanges[0]?.columns)}</li> : null}
      {operators.filter((op) => op.arguments).map((op) => (
        <li key={op.nodeId}>
          {op.name} {op.nodeId}{op.global === undefined ? '' : op.global ? ' (global sort)' : ' (sort within partitions)'}: {op.arguments}
        </li>
      ))}
      {widths.length > 0 ? <li>Rows read: {widths.join('; ')}</li> : null}
      {partitioned.length > 0 ? <li>Exchange: {partitioned.map(formatExchangeArguments).join('; ')}</li> : null}
      {sqlDescription ? <li>SQL: {sqlDescription}</li> : null}
    </ul>
  );
}

/** One flagged stage's row. */
function SpillRow({
  finding,
  appModel,
}: {
  finding: Finding & { stageId: number };
  appModel: WidgetProps['appModel'];
}) {
  const anchor = useAnchoredRow([finding]);
  const density = useWidgetDensity();
  const stated = useStatedAbove(finding);
  const stage = appModel.stages.get(finding.stageId);
  const cls = classificationOf(appModel, finding.stageId);
  // A job's own repartition(n) sets the input partitioning, so spark.sql.shuffle.partitions would not change it.
  const ownPartitioning = finding.type === 'spill' && finding.exchanges?.[0]?.origin === 'REPARTITION_BY_NUM';
  const partitionHint = cls === 'volume' && stage && !ownPartitioning ? recommendPartitions(stage) : null;
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
          {stated ? null : <StagePill stageId={finding.stageId} />}
        </div>
        <AdvancedOnly>
          <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} />
        </AdvancedOnly>
      </div>
      <p className="text-sm">
        {/* spill's value is always a numeric byte count; the line above an evidence panel states it. */}
        {stated ? null : (
          <>
            Memory spilled: <strong>{formatBytes(numericValue(finding))}</strong>
            {' · '}
          </>
        )}
        Disk: {formatBytes(stage?.diskBytesSpilled ?? 0)}
      </p>
      {finding.type === 'spill' ? <SpillEvidence finding={finding} stated={stated} /> : null}
      <ImpactEstimate finding={finding} />
      {partitionHint ? <PartitionHint hint={partitionHint} /> : null}
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
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const [page, setPage] = useState(0);

  // Depends only on `catalog` and `sortMode`; memoized to skip recompute on
  // unrelated re-renders.
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
      fixFor={sorted}
      impactBand={impactBand}
      badges={
        <>
          <TagBadge type="spill" impactBand={impactBand} />
          {canToggleSort(sorted, (f) => [f], (f) => f.stageId, cardOpen) ? (
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
