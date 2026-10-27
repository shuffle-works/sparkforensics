import { memo, useMemo, useState } from 'react';

import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { StageHeader } from '@/view/StageHeader';
import { useAnyStatedAbove, useInlineEvidence } from '@/view/InlineEvidenceContext';
import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { AppModel, Finding, ImpactBand, StageId, TaskData } from '@sparkforensics/core/types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import type { SlowHostFinding, StragglerFinding } from '@sparkforensics/core/finding-types.ts';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode } from '@/view/useSortMode';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { StageTaskSpread } from '@/view/StageTaskSpread';
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

// The first finding of each stage, so a lookup per stage group is one Map read, not a scan of the list.
function firstByStage<F extends Finding>(findings: F[]): Map<StageId, F> {
  const byStage = new Map<StageId, F>();
  for (const f of findings) if (f.stageId != null && !byStage.has(f.stageId)) byStage.set(f.stageId, f);
  return byStage;
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
  const anchor = useAnchoredRow(group.findings);
  const inline = useInlineEvidence();
  const stageStated = useAnyStatedAbove(group.findings);
  const density = useWidgetDensity();
  // The line above an evidence panel states a finding's label and its stage, so a stated finding keeps
  // only its status marker (Advanced) and the other findings keep their whole line.
  const entries = group.findings.map((f) => ({ finding: f, stated: f.id != null && (inline?.stated.has(f.id) ?? false) }));
  const listed = entries.filter(({ finding: f, stated }) => !stated || (density === 'advanced' && Boolean(f.confidence) && f.confidence !== 'high'));
  // tinyTask's sentence states the median task duration, so its P50 is not repeated.
  const p50Stated = entries.some(({ finding: f, stated }) => stated && f.type === 'tinyTask');
  const showPlanExplorer = density === 'advanced' && resolvePlanTree(group.stageId, appModel);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <StageHeader stageId={group.stageId} appModel={appModel} stated={stageStated} />
      {listed.length > 0 ? (
        <ul className="flex flex-col gap-1.5">
          {listed.map(({ finding: f, stated }, i) => (
            <li key={i} className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
              {stated ? null : (
                <>
                  <ImpactDot impactBand={f.impactBand} />
                  <span>{findingLabel(f)}</span>
                  <ImpactEstimate finding={f} />
                </>
              )}
              <AdvancedOnly>
                <RowStatusCluster confidence={f.confidence} validationRequired={f.validationRequired} />
              </AdvancedOnly>
            </li>
          ))}
        </ul>
      ) : null}
      <StageTaskSpread
        stageId={group.stageId}
        appModel={appModel}
        getTaskData={getTaskData}
        idPrefix={idPrefix}
        p50Stated={p50Stated}
        between={
          <>
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
          </>
        }
      >
        {showPlanExplorer ? <PlanExplorer stageId={group.stageId} appModel={appModel} /> : null}
      </StageTaskSpread>
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
 * cross-reference callout, is shared. Renders nothing when the catalog has no matching findings.
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
  const { sortMode, setSortMode, orderBy, canToggleSort } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);

  const { relevant, stageGroups, orderedGroups } = useMemo(() => {
    const relevant = catalog.filter((f) => f.type === type);

    const groupsByStage = new Map<StageId, Finding[]>();
    for (const f of relevant) {
      if (f.stageId == null) continue;
      if (!groupsByStage.has(f.stageId)) groupsByStage.set(f.stageId, []);
      groupsByStage.get(f.stageId)!.push(f);
    }

    const slowHostByStage = firstByStage(findingsOfType(catalog, 'slowHost'));
    const stragglerByStage = firstByStage(findingsOfType(catalog, 'straggler'));

    const stageGroups: StageGroup[] = [...groupsByStage.entries()]
      .map(([stageId, findings]) => ({
        stageId,
        findings,
        impactBand: worstImpactBand(findings) ?? 'info',
        slowHost: slowHostByStage.get(stageId),
        straggler: stragglerByStage.get(stageId),
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
  const { totalPages, effectivePage, visible } = usePagedRows(orderedGroups, page, setPage, routeIndex);

  if (relevant.length === 0) return null;

  const widgetImpactBand = worstImpactBand(relevant);

  return (
    <WidgetCard
      title={title}
      impactBand={widgetImpactBand}
      fixFor={relevant}
      badges={
        <>
          <TagBadge type={type} impactBand={widgetImpactBand ?? 'info'} />
          {canToggleSort(stageGroups, (g) => g.findings, (g) => g.stageId, cardOpen) ? (
            <SortModeToggle mode={sortMode} onChange={setSortMode} />
          ) : null}
        </>
      }
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={`${stageGroups.length} stage${stageGroups.length === 1 ? '' : 's'}`}
          context={findingCount(relevant.length)}
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
