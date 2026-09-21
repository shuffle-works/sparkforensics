import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/view/CollapsibleSection';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { CHART_COLORS, ChartFrame } from '@/view/charts/ChartTheme';
import { DurationHistogram } from '@/view/charts/DurationHistogram';
import { Section } from '@/view/Section';
import { TagBadge } from '@/view/ImpactBadge';
import { useStageDetail } from '@/view/StageDetailContext';
import { ImpactEstimate, formatImpactEstimateCompact } from '../ImpactEstimate.tsx';
import { PlanView, resolvePlanTree } from '@/view/widgets/PlanView';
import { formatBytes, formatDuration, IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding, ImpactBand, Stage, TaskData } from '@sparkforensics/core/types.ts';

export interface StageDetailDialogProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (stageId: number) => Promise<TaskData>;
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
          <XAxis dataKey="locality" tick={{ fontSize: 10 }} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={32} />
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

interface RecEntry {
  extended: string | null;
}

/** Groups a stage's findings by `type`, one chip per type with its distinct
 * recommendations underneath, worst-impact-band-first. Tracks the
 * worst-impact-band finding itself (not just its band) so the compact chip and
 * expanded `<ImpactEstimate>` reuse the finding that drove the displayed band. */
function groupFindingsByType(findings: Finding[]): [string, { impactBand: ImpactBand; finding: Finding; recs: Map<string, RecEntry> }][] {
  const groups = new Map<string, { impactBand: ImpactBand; finding: Finding; recs: Map<string, RecEntry> }>();
  for (const f of findings) {
    if (!groups.has(f.type)) groups.set(f.type, { impactBand: f.impactBand, finding: f, recs: new Map() });
    const g = groups.get(f.type)!;
    if (IMPACT_BAND_ORDER[f.impactBand] < IMPACT_BAND_ORDER[g.impactBand]) {
      g.impactBand = f.impactBand;
      g.finding = f;
    }
    if (f.recommendation && !g.recs.has(f.recommendation)) {
      g.recs.set(f.recommendation, {
        extended: (f.extended as string | undefined) ?? null,
      });
    }
  }
  return [...groups.entries()].sort(([, a], [, b]) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]);
}

/** One finding-type's recommendation line, plus its extended text and impact
 * estimate, all shown unconditionally: no disclosure to open. */
function RecommendationRow({
  rec,
  extended,
  finding,
  showImpactEstimate,
}: {
  rec: string;
  extended: string | null;
  finding: Finding;
  showImpactEstimate: boolean;
}) {
  return (
    <div className="space-y-1 text-sm">
      <p className="max-w-full leading-normal break-words">{rec}</p>
      {extended ? <p className="text-xs text-muted-foreground">{extended}</p> : null}
      {showImpactEstimate ? <ImpactEstimate finding={finding} /> : null}
    </div>
  );
}

/** "Why was this stage flagged": every finding for the open stage, grouped by
 * type. Renders nothing when the stage carries no findings. */
function StageVerdict({ findings }: { findings: Finding[] }) {
  if (findings.length === 0) return null;
  const groups = groupFindingsByType(findings);

  return (
    <section className="space-y-3 rounded-md border p-3">
      {groups.map(([type, { impactBand, finding, recs }]) => {
        // Gate on the compact formatter, not the mere presence of `impactEstimate`:
        // an informational estimate has the field but `<ImpactEstimate>` renders
        // nothing for it, which would leave an empty gap below the recommendation.
        const hasEstimate = formatImpactEstimateCompact(finding.impactEstimate) !== null;
        return (
          <div key={type} className="space-y-1">
            <TagBadge type={type} impactBand={impactBand} />
            {[...recs.entries()].map(([rec, { extended }], i) => (
              <RecommendationRow
                key={i}
                rec={rec}
                extended={extended}
                finding={finding}
                // Per-type figure: show only once, on the first recommendation.
                showImpactEstimate={i === 0 && hasEstimate}
              />
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** "Query Plan" section: the shared PlanView tree/summary toggle. Renders
 * nothing when the stage has no linked SQL execution or plan tree. Collapsed
 * by default, like every other section in this dialog. */
function PlanSection({ stage, appModel }: { stage: Stage; appModel: AppModel }) {
  if (!resolvePlanTree(stage.id, appModel)) return null;
  return (
    <CollapsibleSection title="Query Plan">
      <PlanView stageId={stage.id} appModel={appModel} />
    </CollapsibleSection>
  );
}

interface StageDetailBodyProps {
  stage: Stage;
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (stageId: number) => Promise<TaskData>;
}

function StageDetailBody({ stage, appModel, catalog, getTaskData }: StageDetailBodyProps) {
  const { exportMode, getTaskData: liveGetTaskData } = useLiveTaskData(getTaskData);
  const [taskData, setTaskData] = useState<TaskData | null>(null);
  const [taskDataError, setTaskDataError] = useState(false);
  const [taskDataRetryCount, setTaskDataRetryCount] = useState(0);
  const hasTaskHist = (stage.taskCount ?? 0) > 0;
  const findings = catalog.filter((f) => f.stageId === stage.id);

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
      <StageVerdict findings={findings} />

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
          exportMode ? (
            <p className="text-xs text-muted-foreground">Per-task duration data isn&rsquo;t included in exported reports.</p>
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
 * hand-rolled focus trap). Renders nothing until a stage is open. Sections:
 * verdict (always expanded), then Overview (expanded by default; duration,
 * timestamps, SQL execution, stage type), Tasks (+ duration histogram),
 * Locality (+ bar chart), I/O, Spill and GC (both conditional), an
 * Advanced-only call-stack toggle, and a hierarchical SQL plan tree, each a
 * `CollapsibleSection` collapsed by default unless noted (not the flat
 * `PlanExplorer` accordion used elsewhere; unlike `PlanExplorer`'s embeds,
 * this one stays visible at Basic). */
export function StageDetailDialog({ appModel, catalog, getTaskData }: StageDetailDialogProps) {
  const { stageId, close } = useStageDetail();
  const stage = stageId != null ? appModel.stages.get(stageId) : undefined;
  const open = stage != null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) close();
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-4xl">
        {stage ? (
          <>
            <DialogHeader>
              <DialogTitle>
                Stage {stage.id} <span className="text-muted-foreground">&mdash; {stage.name ?? ''}</span>
              </DialogTitle>
            </DialogHeader>
            <StageDetailBody key={stage.id} stage={stage} appModel={appModel} catalog={catalog} getTaskData={getTaskData} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
