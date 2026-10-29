import { useEffect, useRef, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/view/CollapsibleSection';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { CHART_COLORS, ChartFrame } from '@/view/charts/ChartTheme';
import { DurationHistogram } from '@/view/charts/DurationHistogram';
import { Section } from '@/view/Section';
import type { TriageTarget } from '@/view/triage-target';
import { useStageDetail } from '@/view/StageDetailContext';
import { PlanView, resolvePlanTree } from '@/view/widgets/PlanView';
import { StageFindings } from '@/view/widgets/StageFindings';
import { formatBytes, formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding, Stage, TaskData } from '@sparkforensics/core/types.ts';

export interface StageDetailDialogProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (stageId: number) => Promise<TaskData>;
  /** Routes to a finding's evidence widget on the board. Omitted where there
   * is no board to route to; the dialog then shows no Show evidence buttons. */
  onRoute?: (target: TriageTarget) => void;
  /** Lists info findings too, as the dashboard does once its filter selects the
   * info band. Off by default: info findings are counted as hidden notes. */
  showInfo?: boolean;
}

interface LocalityStat {
  locality: string;
  count: number;
}

// PROCESS_LOCAL (good) -> ANY (bad).
const LOCALITY_ORDER = ['PROCESS_LOCAL', 'NODE_LOCAL', 'RACK_LOCAL', 'NO_PREF', 'ANY'];
const LOCALITY_COLORS = [
  CHART_COLORS.clean,
  CHART_COLORS.accent,
  CHART_COLORS.warning,
  CHART_COLORS.muted,
  CHART_COLORS.critical,
];

function formatTimestamp(ms?: number): string {
  if (!ms) return '—';
  return new Date(ms).toLocaleString();
}

/** Small per-stage locality bar chart. */
function LocalityChart({ stats }: { stats: LocalityStat[] }) {
  const byName = new Map(stats.map((s) => [s.locality, s.count]));
  const labels = LOCALITY_ORDER.filter((k) => byName.has(k));
  for (const s of stats) if (!LOCALITY_ORDER.includes(s.locality)) labels.push(s.locality);
  const rows = labels.map((locality, i) => ({
    locality,
    count: byName.get(locality) ?? 0,
    color: LOCALITY_COLORS[Math.min(i, LOCALITY_COLORS.length - 1)],
  }));

  return (
    <ChartFrame
      ariaLabel="Task locality distribution"
      height={140}
      table={{
        caption: 'Task locality distribution',
        columns: ['Locality tier', 'Task count'],
        rows: rows.map((r) => [r.locality, r.count]),
        align: ['left', 'right'],
      }}
    >
        <BarChart data={rows}>
          <CartesianGrid vertical={false} stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
          <XAxis dataKey="locality" tick={{ fontSize: 12 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={32} />
          <Tooltip formatter={(value) => [`${Number(value)} task${Number(value) === 1 ? '' : 's'}`, 'Tasks']} />
          <Bar dataKey="count" name="Tasks">
            {rows.map((r) => (
              <Cell key={r.locality} fill={r.color} />
            ))}
          </Bar>
        </BarChart>
    </ChartFrame>
  );
}

/** "Query Plan" section: the shared PlanView tree/summary toggle. Renders
 * nothing when the stage has no linked SQL execution or plan tree. Collapsed
 * by default, like every other section in this dialog. */
function PlanSection({ stage, appModel }: { stage: Stage; appModel: AppModel }) {
  if (!resolvePlanTree(stage.id, appModel)) return null;
  return (
    <CollapsibleSection title="Query Plan" lazy>
      <PlanView stageId={stage.id} appModel={appModel} />
    </CollapsibleSection>
  );
}

interface StageDetailBodyProps {
  stage: Stage;
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (stageId: number) => Promise<TaskData>;
  onShowEvidence?: (target: TriageTarget) => void;
  showInfo: boolean;
}

function StageDetailBody({ stage, appModel, catalog, getTaskData, onShowEvidence, showInfo }: StageDetailBodyProps) {
  const { unavailable: noTaskData, getTaskData: liveGetTaskData } = useLiveTaskData(getTaskData);
  const [taskData, setTaskData] = useState<TaskData | null>(null);
  const [taskDataError, setTaskDataError] = useState(false);
  const [taskDataRetryCount, setTaskDataRetryCount] = useState(0);
  const hasTaskHist = (stage.taskCount ?? 0) > 0;

  // One fetch per dialog open (or manual retry, bumping `taskDataRetryCount`):
  // the caller mounts a fresh `StageDetailBody` keyed by stage id per stage.
  // `.catch(() => null)` then treats a falsy resolve as a rejection so the UI
  // never gets stuck on "Loading".
  useEffect(() => {
    if (!hasTaskHist || !liveGetTaskData) return;
    let cancelled = false;
    setTaskDataError(false);
    liveGetTaskData(stage.id)
      .catch(() => null)
      .then((data) => {
        if (cancelled) return;
        if (data) setTaskData(data);
        else setTaskDataError(true);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- re-runs only on manual retry, see comment above
  }, [taskDataRetryCount]);

  const duration = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const hasSpill = (stage.memoryBytesSpilled ?? 0) > 0 || (stage.diskBytesSpilled ?? 0) > 0;
  const hasGc = (stage.jvmGCTime ?? 0) > 0 || (stage.gcPct ?? 0) > 0;
  const fetchWaitTime = stage.fetchWaitTime ?? 0;
  const fetchWaitPct = fetchWaitTime > 0 && duration > 0 ? Math.round((fetchWaitTime / duration) * 100) : null;
  const ioRatio =
    (stage.inputBytes ?? 0) > 0 ? ((stage.outputBytes ?? 0) / (stage.inputBytes ?? 0)).toFixed(2) : null;
  const localityStats = stage.localityStats ?? [];

  return (
    <div className="space-y-6">
      <StageFindings stage={stage} catalog={catalog} showInfo={showInfo} onShowEvidence={onShowEvidence} />

      <Section
        title="Overview"
        collapsible
        defaultOpen
        rows={[
          ['Duration', formatDuration(duration)],
          ['Submitted', formatTimestamp(stage.submittedAt)],
          ['Completed', formatTimestamp(stage.completedAt)],
          stage.sqlExecutionId != null && ['SQL Execution', `#${stage.sqlExecutionId}`],
          stage.stageType ? ['Stage type', stage.stageType] : false,
        ]}
      />

      <Section
        title="Tasks"
        collapsible
        rows={[
          ['Total', String(stage.taskCount)],
          ['Failed', String(stage.failedTasks)],
          ['P50 duration', (stage.taskDurationP50 ?? 0) > 0 ? formatDuration(stage.taskDurationP50) : '—'],
          ['P95 duration', (stage.taskDurationP95 ?? 0) > 0 ? formatDuration(stage.taskDurationP95) : '—'],
          ['Max duration', (stage.taskDurationMax ?? 0) > 0 ? formatDuration(stage.taskDurationMax) : '—'],
          (stage.peakExecutionMemoryMax ?? 0) > 0 && [
            'Peak execution memory',
            formatBytes(stage.peakExecutionMemoryMax as number),
          ],
        ]}
      >
        {hasTaskHist ? (
          noTaskData ? (
            <p className="text-xs text-muted-foreground">Per-task duration data isn&rsquo;t available for this run.</p>
          ) : taskData ? (
            <DurationHistogram
              metrics={taskData.metrics}
              fieldNames={taskData.fieldNames}
              markers={{ p50: stage.taskDurationP50, p95: stage.taskDurationP95 }}
            />
          ) : taskDataError ? (
            <div className="flex items-center gap-2">
              <p className="text-xs text-muted-foreground">Couldn&rsquo;t load task data for this stage.</p>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setTaskDataRetryCount((n) => n + 1)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Loading task data&hellip;</p>
          )
        ) : null}
      </Section>

      <Section title="Locality" collapsible rows={[]}>
        {localityStats.length > 0 ? <LocalityChart stats={localityStats} /> : null}
      </Section>

      <Section
        title="I/O"
        collapsible
        rows={[
          ['Input', formatBytes(stage.inputBytes)],
          ['Output', formatBytes(stage.outputBytes)],
          ['Shuffle read', formatBytes(stage.shuffleReadBytes)],
          ['Shuffle write', formatBytes(stage.shuffleWriteBytes)],
          fetchWaitTime > 0 && [
            'Fetch wait',
            `${formatDuration(fetchWaitTime)}${fetchWaitPct != null ? ` (${fetchWaitPct}%)` : ''}`,
          ],
          ioRatio != null && ['I/O ratio', ioRatio],
        ]}
      />

      {hasSpill ? (
        <Section
          title="Spill"
          collapsible
          rows={[
            ['Memory spilled', formatBytes(stage.memoryBytesSpilled)],
            ['Disk spilled', formatBytes(stage.diskBytesSpilled)],
            (stage.memoryBytesSpilled ?? 0) > 0 && ['Classification', stage.spillClassification ?? 'unclassified'],
          ]}
        />
      ) : null}

      {hasGc ? (
        <Section
          title="GC"
          collapsible
          rows={[
            ['JVM GC time', formatDuration(stage.jvmGCTime)],
            ['Executor run time', formatDuration(stage.executorRunTime)],
            ['GC %', `${(stage.gcPct ?? 0).toFixed(1)}%`],
          ]}
        />
      ) : null}

      {stage.details ? (
        <AdvancedOnly>
          <CollapsibleSection title="Call Stack">
            <pre className="overflow-x-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">{stage.details}</pre>
          </CollapsibleSection>
        </AdvancedOnly>
      ) : null}

      <PlanSection stage={stage} appModel={appModel} />
    </div>
  );
}

/** Stage-detail modal: opened via `useStageDetail().openStage(id)`, closed via
 * Escape/backdrop/close-button (all owned by the base-ui `Dialog`, no
 * hand-rolled focus trap). Renders nothing until a stage is open. Body
 * sections are `CollapsibleSection`s, collapsed by default unless noted; the
 * SQL plan tree is hierarchical (not the flat `PlanExplorer` accordion) and,
 * unlike `PlanExplorer`'s embeds, stays visible at Basic. */
export function StageDetailDialog({ appModel, catalog, getTaskData, onRoute, showInfo = false }: StageDetailDialogProps) {
  const { stageId, close } = useStageDetail();
  const stage = stageId != null ? appModel.stages.get(stageId) : undefined;
  const open = stage != null;
  // Set while the dialog closes to route: the route focuses the evidence, so
  // the dialog must not hand focus back to the control that opened it.
  const routingRef = useRef(false);
  const showEvidence = onRoute
    ? (target: TriageTarget) => {
        routingRef.current = true;
        close();
        onRoute(target);
      }
    : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent
        className="max-h-[85vh] overflow-y-auto sm:max-w-4xl"
        finalFocus={() => {
          const routing = routingRef.current;
          routingRef.current = false;
          return !routing;
        }}
      >
        {stage ? (
          <>
            <DialogHeader>
              <DialogTitle>Stage {stage.id}</DialogTitle>
              {/* Spark names a stage after the code line that created it, which
                  reads as noise until you know that; say what it is. */}
              {stage.name ? (
                <DialogDescription className="font-mono text-xs [overflow-wrap:anywhere]">
                  <span className="font-sans">Code location: </span>
                  {stage.name}
                </DialogDescription>
              ) : null}
            </DialogHeader>
            <StageDetailBody
              key={stage.id}
              stage={stage}
              appModel={appModel}
              catalog={catalog}
              getTaskData={getTaskData}
              onShowEvidence={showEvidence}
              showInfo={showInfo}
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
