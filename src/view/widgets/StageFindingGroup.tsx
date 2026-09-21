import { memo, useMemo, useState } from 'react';

import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { StageHeader } from '@/view/StageHeader';
import { ExpandToggleButton } from '@/view/ExpandToggleButton';
import { DurationHistogram } from '@/view/charts/DurationHistogram';
import { IMPACT_BAND_ORDER, formatDuration, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { AppModel, Finding, ImpactBand, StageId, TaskData } from '@sparkforensics/core/types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import type { SlowHostFinding, StragglerFinding } from '@/view/slow-host-straggler-finding';
import { useExpandableRow } from '@/view/useExpandableRow';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { useWidgetDensity } from '@/store/store';
import { PlanExplorer } from './PlanExplorer';
import { resolvePlanTree } from './PlanView';

interface StageGroup {
  stageId: StageId;
  impactBand: ImpactBand;
  findings: Finding[];
  slowHost?: SlowHostFinding;
  straggler?: StragglerFinding;
}

export interface StageFindingGroupWidgetProps extends Pick<WidgetProps, 'appModel' | 'catalog' | 'getTaskData' | 'defaultCollapsed'> {
  /** The `finding.type` this board scopes to, e.g. `'skew'`. */
  type: string;
  /** `WidgetCard` title, e.g. "Task Skew". */
  title: string;
  /** Prefix for this widget's per-stage detail-disclosure DOM ids, e.g.
   * `'skew'` -> `skew-stage-3-detail`. Kept distinct per caller so sibling
   * widgets never collide if they're ever rendered on the same page. */
  idPrefix: string;
  /** Per-finding label line. Stays a caller-supplied prop rather than one
   * shared formatter: each detector's finding shape differs (skew varies by
   * `metric`, stageShape by `rule`, tinyTask has one fixed shape), so the
   * format string is genuinely different per caller, not just duplicated. */
  findingLabel: (f: Finding) => string;
}

interface StageFindingGroupRowProps {
  group: StageGroup;
  appModel: AppModel;
  getTaskData: (id: number) => Promise<TaskData>;
  idPrefix: string;
  findingLabel: (f: Finding) => string;
}

function StageFindingGroupRow({ group, appModel, getTaskData, idPrefix, findingLabel }: StageFindingGroupRowProps) {
  const { exportMode, getTaskData: liveGetTaskData } = useLiveTaskData(getTaskData);
  const { expanded, data: taskData, error: taskDataError, toggle } = useExpandableRow(
    liveGetTaskData ? () => liveGetTaskData(group.stageId) : undefined,
  );
  const anchor = useAnchoredRow(group.findings);
  const stage = appModel.stages.get(group.stageId);
  const density = useWidgetDensity();
  const showPlanExplorer = density === 'advanced' && resolvePlanTree(group.stageId, appModel);
  const detailId = `${idPrefix}-stage-${group.stageId}-detail`;

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <StageHeader stageId={group.stageId} appModel={appModel} />
      <ul className="flex flex-col gap-1.5">
        {group.findings.map((f, i) => (
          <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <ImpactDot impactBand={f.impactBand} />
            <span>{findingLabel(f)}</span>
            <ImpactEstimate finding={f} />
            <AdvancedOnly>
              <RowStatusCluster confidence={f.confidence} validationRequired={f.validationRequired} />
            </AdvancedOnly>
          </li>
        ))}
      </ul>
      {stage?.taskDurationP50 != null ? (
        <p className="text-xs text-muted-foreground">
          P50 {formatDuration(stage.taskDurationP50)} &middot; P95 {formatDuration(stage.taskDurationP95)} &middot; Max{' '}
          {formatDuration(stage.taskDurationMax)}
        </p>
      ) : null}
      {group.slowHost ? (
        <p className="flex items-start gap-2 text-xs">
          <ImpactDot impactBand={group.slowHost.impactBand} className="mt-1" />
          <span>
            <strong>Slow host:</strong> {group.slowHost.host} ({group.slowHost.value}&times; median,{' '}
            {Math.round((group.slowHost.hostTaskShare ?? 0) * 100)}% of tasks)
          </span>
        </p>
      ) : null}
      {group.straggler ? (
        <p className="flex items-start gap-2 text-xs">
          <ImpactDot impactBand={group.straggler.impactBand} className="mt-1" />
          <span>
            <strong>Stragglers:</strong>{' '}
            {(group.straggler.speculativeTasks ?? 0) > 0
              ? `${group.straggler.speculativeTasks} speculative task${group.straggler.speculativeTasks === 1 ? '' : 's'}`
              : `${group.straggler.value}% of tasks > 4× P50`}
          </span>
        </p>
      ) : null}
      <ExpandToggleButton
        expanded={expanded}
        onClick={toggle}
        label="Task detail"
        location={`Stage ${group.stageId}`}
        controlsId={detailId}
      />
      {expanded ? (
        <div id={detailId} className="space-y-3 pt-1">
          {taskData ? (
            <DurationHistogram
              metrics={taskData.metrics}
              fieldNames={taskData.fieldNames}
              markers={{ p50: stage?.taskDurationP50, p95: stage?.taskDurationP95 }}
            />
          ) : exportMode ? (
            <p className="text-xs text-muted-foreground">Task data isn&rsquo;t included in exported reports.</p>
          ) : taskDataError ? (
            <p className="text-xs text-muted-foreground">Task data unavailable for this stage.</p>
          ) : (
            <p className="text-xs text-muted-foreground">Loading task data&hellip;</p>
          )}
          {showPlanExplorer ? <PlanExplorer stageId={group.stageId} appModel={appModel} /> : null}
        </div>
      ) : null}
    </div>
  );
}

/**
 * Shared implementation behind `Skew.tsx`, `StageShape.tsx`, and
 * `TinyTask.tsx`: three widgets that all flag every stage carrying a given
 * finding type (never just the worst one), each row expandable into a
 * duration histogram (lazily fetched via `getTaskData`) plus the stage's SQL
 * plan context (Advanced density only). The three differ only in which
 * `finding.type` they scope to, their title, and how they format a finding
 * into a label line; everything else here, including the slow-host/straggler
 * cross-reference callout, was previously duplicated verbatim across all
 * three files. Renders nothing when the catalog has no matching findings.
 */
export const StageFindingGroupWidget = memo(function StageFindingGroupWidget({
  appModel,
  catalog,
  getTaskData,
  defaultCollapsed = true,
  type,
  title,
  idPrefix,
  findingLabel,
}: StageFindingGroupWidgetProps) {
  const [page, setPage] = useState(0);
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);

  const { relevant, stageGroups, orderedGroups } = useMemo(() => {
    const relevant = catalog.filter((f) => f.type === type);

    const groupsByStage = new Map<StageId, Finding[]>();
    for (const f of relevant) {
      if (f.stageId == null) continue;
      if (!groupsByStage.has(f.stageId)) groupsByStage.set(f.stageId, []);
      groupsByStage.get(f.stageId)!.push(f);
    }

    const stageGroups: StageGroup[] = [...groupsByStage.entries()]
      .map(([stageId, findings]) => ({
        stageId,
        findings,
        impactBand: worstImpactBand(findings) ?? 'info',
        slowHost: catalog.find((f) => f.type === 'slowHost' && f.stageId === stageId) as SlowHostFinding | undefined,
        straggler: catalog.find((f) => f.type === 'straggler' && f.stageId === stageId) as StragglerFinding | undefined,
      }))
      .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand] || a.stageId - b.stageId);

    const orderedGroups = orderBy(stageGroups, (g) => g.findings, (g) => g.stageId);

    return { relevant, stageGroups, orderedGroups };
  }, [catalog, sortMode, type]);

  // Groups, not raw findings, are paginated here, so routing to a finding must
  // locate the group containing it (groups hold the same catalog-finding refs).
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget
    ? orderedGroups.findIndex((g) => g.findings.some((f) => f === activeRouteTarget.finding))
    : null;
  // Called unconditionally, before the "no findings" early return, per rules of
  // hooks (usePagedRows uses useLayoutEffect internally).
  const { totalPages, effectivePage, visible } = usePagedRows(orderedGroups, page, setPage, routeIndex);

  if (relevant.length === 0) return null;

  const widgetImpactBand = worstImpactBand(relevant);

  return (
    <WidgetCard
      title={title}
      impactBand={widgetImpactBand}
      badges={
        <>
          <TagBadge type={type} impactBand={widgetImpactBand ?? 'info'} />
          {canToggleSort(relevant, stageGroups.length, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={`${stageGroups.length} stage${stageGroups.length === 1 ? '' : 's'}`}
          context={`${relevant.length} finding${relevant.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <div className="space-y-3">
        {visible.map((group) => (
          <StageFindingGroupRow
            key={group.stageId}
            group={group}
            appModel={appModel}
            getTaskData={getTaskData}
            idPrefix={idPrefix}
            findingLabel={findingLabel}
          />
        ))}
      </div>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
