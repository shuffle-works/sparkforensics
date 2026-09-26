import { useEffect, useRef, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { Button } from '@/components/ui/button';
import { CollapsibleSection } from '@/view/CollapsibleSection';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { CHART_COLORS, ChartFrame } from '@/view/charts/ChartTheme';
import { DurationHistogram } from '@/view/charts/DurationHistogram';
import { Section } from '@/view/Section';
import { findingActionLabel } from '@/view/finding-action-label';
import { TAG_HELP } from '@/view/finding-tag-help';
import { TagBadge } from '@/view/ImpactBadge';
import { buildNextSteps } from '@/view/run-verdict';
import { summarizeRunOutcome } from '@/view/run-outcome';
import { selectTriageTargetForFinding, type TriageTarget } from '@/view/triage-target';
import { hasCompleteApplicationInterval } from '@/view/widgets/scorecard-estimates';
import { useStageDetail } from '@/view/StageDetailContext';
import { ImpactEstimate, formatImpactEstimateCompact } from '../ImpactEstimate.tsx';
import { PlanView, resolvePlanTree } from '@/view/widgets/PlanView';
import { formatBytes, formatDuration, IMPACT_BAND_ORDER, typeTag } from '@sparkforensics/core/format-utils.ts';
import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import type { AppModel, Finding, ImpactBand, Stage, TaskData } from '@sparkforensics/core/types.ts';

export interface StageDetailDialogProps {
  appModel: AppModel;
  catalog: Finding[];
  getTaskData: (stageId: number) => Promise<TaskData>;
  /** Routes to a finding's evidence widget on the board. Omitted where there
   * is no board to route to; the dialog then shows no Show evidence buttons. */
  onRoute?: (target: TriageTarget) => void;
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
 * recommendations underneath, in the run verdict's order. Tracks the
 * worst-impact-band finding itself (not just its band) so the compact chip and
 * expanded `<ImpactEstimate>` reuse the finding that drove the displayed band. */
function groupFindingsByType(
  findings: Finding[],
  failedJobStageIds: ReadonlySet<number> | null,
): [string, { impactBand: ImpactBand; finding: Finding; recs: Map<string, RecEntry> }][] {
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
  // The run verdict's own step order (buildNextSteps: potential savings, and
  // failures first on a failed run), so "start with the first" agrees with
  // it. Types the verdict can't route follow, worst band first.
  const [step] = buildNextSteps(findings, failedJobStageIds ? { failedJobStageIds } : {});
  const verdictOrder = step ? [step.lead.finding.type, ...step.related.map((f) => f.type)] : [];
  const rank = (type: string) => (verdictOrder.includes(type) ? verdictOrder.indexOf(type) : verdictOrder.length);
  return [...groups.entries()].sort(
    ([aType, a], [bType, b]) => rank(aType) - rank(bType) || IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
  );
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
      <p className="max-w-full leading-normal break-words">
        <span className="font-medium">What to try: </span>
        {rec}
      </p>
      {extended ? <p className="text-xs text-muted-foreground">{extended}</p> : null}
      {showImpactEstimate ? <ImpactEstimate finding={finding} /> : null}
    </div>
  );
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

/** One plain sentence placing the stage in the run: how long it ran, what
 * share of the run that was, how many tasks it split into, and how many
 * findings it carries. */
function stageSummary(stage: Stage, runMs: number | null, findingTypes: number): string {
  const duration = (stage.completedAt ?? 0) - (stage.submittedAt ?? 0);
  const parts: string[] = [];
  if (duration > 0) {
    const share = runMs != null && runMs > 0 ? Math.round((duration / runMs) * 100) : null;
    parts.push(`Ran for ${formatDuration(duration)}${share != null ? `, ${share}% of this ${formatDuration(runMs!)} run` : ''}`);
  }
  if ((stage.taskCount ?? 0) > 0) parts.push(`split into ${plural(stage.taskCount!, 'task')}`);
  const lead = parts.length > 0 ? `${parts.join(', ')}.` : '';
  const found =
    findingTypes === 0
      ? 'Nothing was flagged on this stage.'
      : findingTypes === 1
        ? '1 finding here.'
        : `${findingTypes} findings here. They often share one cause, so start with the first.`;
  return [lead, found].filter(Boolean).join(' ');
}

/** "Why was this stage flagged": the stage's place in the run, then every
 * finding for it grouped by type, each read like a verdict step: what to do,
 * what is happening in plain language, what to try, what it could save, and
 * a route to its evidence on the board. */
function StageVerdict({
  stage,
  findings,
  catalog,
  runMs,
  failedJobStageIds,
  onShowEvidence,
}: {
  stage: Stage;
  findings: Finding[];
  catalog: Finding[];
  runMs: number | null;
  failedJobStageIds: ReadonlySet<number> | null;
  onShowEvidence?: (target: TriageTarget) => void;
}) {
  const groups = groupFindingsByType(findings, failedJobStageIds);

  return (
    <section aria-label="Why this stage was flagged" className="space-y-3">
      <p className="text-sm text-muted-foreground">{stageSummary(stage, runMs, groups.length)}</p>
      {groups.length > 0 ? (
        <ol className="space-y-4 rounded-md border p-3">
          {groups.map(([type, { impactBand, finding, recs }]) => {
            // Gate on the compact formatter, not the mere presence of `impactEstimate`:
            // an informational estimate has the field but `<ImpactEstimate>` renders
            // nothing for it, which would leave an empty gap below the recommendation.
            const hasEstimate = formatImpactEstimateCompact(finding.impactEstimate) !== null;
            const help = TAG_HELP[typeTag(type)];
            const target = onShowEvidence ? selectTriageTargetForFinding(finding, catalog) : null;
            return (
              <li key={type} className="space-y-1.5" data-testid="stage-finding">
                <div className="flex flex-wrap items-center gap-2">
                  <TagBadge type={type} impactBand={impactBand} />
                  <h3 className="text-sm font-semibold">{findingActionLabel(finding)}</h3>
                </div>
                {help ? (
                  <p className="text-sm">
                    <span className="font-medium">What's happening: </span>
                    {help.description}
                  </p>
                ) : null}
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
                {target && onShowEvidence ? (
                  <Button size="sm" variant="outline" onClick={() => onShowEvidence(target)}>
                    Show evidence
                    <ArrowRight aria-hidden="true" />
                  </Button>
                ) : null}
              </li>
            );
          })}
        </ol>
      ) : null}
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
  onShowEvidence?: (target: TriageTarget) => void;
}

function StageDetailBody({ stage, appModel, catalog, getTaskData, onShowEvidence }: StageDetailBodyProps) {
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
  const outcome = summarizeRunOutcome(appModel.jobs, catalog);

  return (
    <div className="space-y-6">
      <StageVerdict
        stage={stage}
        findings={findings}
        catalog={catalog}
        runMs={hasCompleteApplicationInterval(appModel.app) ? computeWallClock(appModel.app, appModel.stages).total : null}
        failedJobStageIds={outcome.failedJobs > 0 ? outcome.failedJobStageIds : null}
        onShowEvidence={onShowEvidence}
      />

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
export function StageDetailDialog({ appModel, catalog, getTaskData, onRoute }: StageDetailDialogProps) {
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
            />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
