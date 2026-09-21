import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';

import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { TagBadge } from '@/view/ImpactBadge';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { StageHeader } from '@/view/StageHeader';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { formatDuration, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import type { WidgetProps } from '@/view/detector-registry';
import type { AppModel, Finding } from '@sparkforensics/core/types.ts';
import { ROW_SEPARATOR_CLASS, useAnchoredRow } from '@/view/finding-anchor';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import type { TriageTarget } from '@/view/triage-target';
import { canToggleSort } from '@/view/impact-sort';
import { SortModeToggle } from '@/view/SortModeToggle';
import { useSortMode, type UseSortModeResult } from '@/view/useSortMode';

export type GcPressureProps = Pick<WidgetProps, 'catalog' | 'appModel' | 'defaultCollapsed'>;

// GC % = total JVM GC time ÷ total executor run time: it can exceed 100% when
// GC pauses overlap many concurrent task threads.
const GC_NOTE =
  'GC % = total JVM GC time ÷ total executor run time; it can exceed 100% when GC pauses overlap many concurrent task threads.';

function sortedByValue(findings: Finding[]): Finding[] {
  // gc's value is always a numeric percentage.
  return [...findings].sort((a, b) => (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0));
}

/** One flagged stage's GC%/executor-run-time figures. Every stage gets its own
 * row (never just the worst); the header carries the shared GC tag, so rows
 * don't repeat it. The recommendation is always visible. */
function GcStageRow({ finding, appModel }: { finding: Finding; appModel: AppModel }) {
  const anchor = useAnchoredRow([finding]);
  const stage = finding.stageId != null ? appModel.stages.get(finding.stageId) : undefined;
  const runTime = stage?.executorRunTime;
  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-2 ${ROW_SEPARATOR_CLASS} transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <StageHeader stageId={finding.stageId as number} appModel={appModel} />
        <AdvancedOnly>
          <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} />
        </AdvancedOnly>
      </div>
      <p className="text-xs text-muted-foreground">
        GC: <strong>{finding.value}%</strong> &middot; Executor run time:{' '}
        <strong>{formatDuration(runTime ?? 0)}</strong>
      </p>
      <ImpactEstimate finding={finding} />
      <p className="text-xs text-muted-foreground">{finding.recommendation}</p>
    </li>
  );
}

/** One GC branch's ("GC overhead" / "Low GC") heading and paginated stage-row
 * list. */
function GcSection({
  title,
  findings,
  appModel,
  page,
  setPage,
  routeTarget,
  orderBy,
}: {
  title: string;
  findings: Finding[];
  appModel: AppModel;
  page: number;
  setPage: Dispatch<SetStateAction<number>>;
  routeTarget: TriageTarget | null;
  orderBy: UseSortModeResult['orderBy'];
}) {
  const sorted = sortedByValue(findings);
  const ordered = orderBy(sorted, (f) => [f], (f) => f.stageId as number);
  const routeIndex = routeTarget ? ordered.findIndex((f) => f === routeTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(ordered, page, setPage, routeIndex);

  return (
    <section className="space-y-2">
      <h4 className="font-heading text-sm font-medium">
        {title} &middot; {findings.length} stage{findings.length === 1 ? '' : 's'}
      </h4>
      <ul className="space-y-3">
        {visible.map((f) => (
          <GcStageRow key={f.stageId as number} finding={f} appModel={appModel} />
        ))}
      </ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </section>
  );
}

/** Per-stage GC-time board: the two branches the `gc` detector pushes, a "high
 * GC" branch (garbage collection eating an outsized share of executor run time)
 * and a "low GC / cost" branch (executor memory likely over-provisioned).
 * Renders nothing when neither branch fired for any stage. */
export function GcPressure({ catalog, appModel, defaultCollapsed = true }: GcPressureProps) {
  // Declared unconditionally, before the empty-catalog early return, so hook
  // order stays stable across renders.
  const [highPage, setHighPage] = useState(0);
  const [lowPage, setLowPage] = useState(0);
  const { sortMode, setSortMode, orderBy } = useSortMode();
  const [cardOpen, setCardOpen] = useState(!defaultCollapsed);
  const activeRouteTarget = useActiveRouteTarget();

  // A new file load swaps in a fresh `appModel`: reset pagination so a stale
  // page index can't leave a section on an out-of-range empty slice. Skipped on
  // first run, where page state already starts at 0, so it can't stomp a
  // route-driven page jump when mounting mid-route.
  const mountedRef = useRef(false);
  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }
    setHighPage(0);
    setLowPage(0);
  }, [appModel]);

  const findings = catalog.filter((f) => f.type === 'gc');
  if (findings.length === 0) return null;

  const highFindings = findings.filter((f) => f.direction !== 'low');
  const lowFindings = findings.filter((f) => f.direction === 'low');
  const impactBand = worstImpactBand(findings);

  // Compute worst value for the collapsed summary.
  const worst = [...findings].sort((a, b) => (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0))[0];

  return (
    <WidgetCard
      title="GC Pressure"
      impactBand={impactBand}
      badges={
        <>
          <TagBadge type="gc" impactBand={impactBand ?? 'info'} />
          {canToggleSort(findings, findings.length, cardOpen) ? (
            <SortModeToggle
              mode={sortMode}
              onChange={(next) => {
                setSortMode(next);
                setHighPage(0);
                setLowPage(0);
              }}
            />
          ) : null}
        </>
      }
      defaultCollapsed={defaultCollapsed}
      open={cardOpen}
      onOpenChange={setCardOpen}
      summary={
        <WidgetLeadSummary
          value={`${worst.value}%`}
          context={`${findings.length} stage${findings.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <div className="space-y-4">
        <AdvancedOnly>
          <p className="text-xs text-muted-foreground">{GC_NOTE}</p>
        </AdvancedOnly>

        {highFindings.length > 0 && (
          <GcSection
            title="GC overhead"
            findings={highFindings}
            appModel={appModel}
            page={highPage}
            setPage={setHighPage}
            routeTarget={activeRouteTarget}
            orderBy={orderBy}
          />
        )}

        {lowFindings.length > 0 && (
          <GcSection
            title="Low GC (cost)"
            findings={lowFindings}
            appModel={appModel}
            page={lowPage}
            setPage={setLowPage}
            routeTarget={activeRouteTarget}
            orderBy={orderBy}
          />
        )}
      </div>
    </WidgetCard>
  );
}
