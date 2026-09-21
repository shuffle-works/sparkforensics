import { CartesianGrid, Line, LineChart, Tooltip, XAxis, YAxis } from 'recharts';

import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { checkConcurrentJobGroups } from '@sparkforensics/core/job-groups.ts';
import { simulateScaling } from '@sparkforensics/core/scaling-sim.ts';
import { hasUsableRunAggregates } from '@sparkforensics/core/evidence-availability.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { CHART_COLORS, ChartFrame } from '../charts/ChartTheme';
import { downsample } from '../charts/downsample';
import { DocsLink } from '../DocsContext';
import { RowStatusCluster } from '../RowStatusCluster';
import { WidgetCard } from '../WidgetCard';
import { WidgetLeadSummary } from '../WidgetLeadSummary';

const TITLE = 'What-If Executor Scaling';
const HEIGHT = 220;

// Design-spike (unvalidated) threshold for when Model Error warrants visual
// weight, not just the explanatory sentence next to it.
const MODEL_ERROR_WARN_PCT = 20;

interface ScalingPrediction {
  pct: number;
  cores: number;
  estMakespanMs: number;
}

// Documents the shape of simulateScaling's (untyped) return value.
interface ScalingSimResult {
  baselineCores: number;
  predictions: ScalingPrediction[];
  modelErrorPct: number | null;
}

export interface ScalingSimProps {
  appModel: AppModel;
}

/**
 * Y-axis domain for the makespan chart: tightly fits the predicted-makespan
 * range (plus padding) instead of Recharts' default zero-anchored domain, which
 * compresses the diminishing-returns drop-off into a small band at the top.
 */
export function makespanYAxisDomain([dataMin, dataMax]: readonly [number, number]): [number, number] {
  const padding = (dataMax - dataMin) * 0.1;
  return [Math.max(0, dataMin - padding), dataMax + padding];
}

function hasUsableStageTiming(appModel: AppModel): boolean {
  return [...appModel.stages.values()].some((stage) => {
    const submittedAt = stage.submittedAt;
    const completedAt = stage.completedAt;
    return typeof submittedAt === 'number'
      && Number.isFinite(submittedAt)
      && typeof completedAt === 'number'
      && Number.isFinite(completedAt)
      && completedAt > submittedAt;
  });
}

function taskCoreTimeEntry(appModel: AppModel) {
  return appModel.evidenceAvailability?.entries.find((entry) => entry.key === 'taskCoreTime');
}

function Unavailable({ reason, evidence }: { reason: string; evidence?: 'taskCoreTime' }) {
  return (
    <WidgetCard
      title={TITLE}
      summary={<span className="text-muted-foreground text-xs">Not available: {reason}</span>}
    >
      <p className="text-muted-foreground text-xs">
        Not available: {reason} <RowStatusCluster evidenceKey={evidence} />
      </p>
    </WidgetCard>
  );
}

// What-if scaling simulator. DESIGN SPIKE: predictions are unvalidated; the
// Model Error indicator and the conditional concurrent-job banner keep that
// visible. Not a bottleneck flag: no impact-band border, no badge.
export function ScalingSim({ appModel }: ScalingSimProps) {
  const taskCoreTime = taskCoreTimeEntry(appModel);
  const hasTaskCoreTime = hasUsableRunAggregates(appModel.runAggregates) && (taskCoreTime == null || taskCoreTime.state === 'present');
  if (!hasTaskCoreTime) {
    return <Unavailable reason={taskCoreTime?.summary ?? 'No usable task and core-time evidence in this log.'} evidence="taskCoreTime" />;
  }

  const sim = simulateScaling({
    app: appModel.app,
    stages: appModel.stages,
    runAggregates: appModel.runAggregates,
    executorsAdded: appModel.executors.added,
  }) as ScalingSimResult;

  if (sim.baselineCores <= 0) return <Unavailable reason="Baseline executor/core capacity is unavailable in this log." />;
  if (!hasUsableStageTiming(appModel)) return <Unavailable reason="Usable stage timing is unavailable in this log." />;

  const reliability = checkConcurrentJobGroups(appModel.jobs) as { wallClockReliable: boolean };
  const modelErrorHigh = sim.modelErrorPct != null && sim.modelErrorPct >= MODEL_ERROR_WARN_PCT;
  const chartData = downsample(sim.predictions);

  // Find the best prediction (lowest makespan, which is at the highest executor percentage)
  const best = sim.predictions.reduce((min, p) => (p.estMakespanMs < min.estMakespanMs ? p : min));

  return (
    <WidgetCard
      title={TITLE}
      defaultCollapsed
      summary={
        <WidgetLeadSummary
          value={formatDuration(best.estMakespanMs)}
          context={`best case at ${best.pct}% executors`}
        />
      }
    >
      <div className="space-y-3">
        <AdvancedOnly>
          <p className="text-muted-foreground text-xs">
            Model Error:{' '}
            <strong className={modelErrorHigh ? 'text-warning' : undefined}>
              {sim.modelErrorPct == null ? '—' : `${sim.modelErrorPct}%`}
            </strong>{' '}
            (idealized makespan vs. observed); higher means all estimates below are less
            trustworthy. Predictions are unvalidated (a single log observes only one scale).
          </p>
        </AdvancedOnly>
        <p className="text-muted-foreground text-xs">
          Move along this curve by changing <code>spark.dynamicAllocation</code>&rsquo;s executor
          bounds, see the <DocsLink anchor="#config-autoscale-bounds">autoscaling config guide</DocsLink>.
        </p>
        {!reliability.wallClockReliable ? (
          <AdvancedOnly>
            <p className="text-muted-foreground text-xs">
              This run used concurrent job groups, so the wall-clock-based estimates below may be
              unreliable.
            </p>
          </AdvancedOnly>
        ) : null}
        <AdvancedOnly>
          <p className="text-xs">
            <RowStatusCluster evidenceKey="taskCoreTime" />
          </p>
        </AdvancedOnly>
        <ChartFrame
          ariaLabel="Estimated makespan by executor percentage: diminishing-returns curve."
          height={HEIGHT}
            table={{
              caption: 'Estimated makespan by executor percentage',
              columns: ['% Executors', 'Cores', 'Est. makespan'],
              rows: sim.predictions.map((p) => [`${p.pct}%`, p.cores, formatDuration(p.estMakespanMs)]),
              align: ['right', 'right', 'right'],
            }}
          >
            <LineChart data={chartData}>
              <CartesianGrid stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
              <XAxis
                dataKey="pct"
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 10 }}
              />
              <YAxis
                domain={makespanYAxisDomain}
                tickFormatter={(v: number) => formatDuration(v)}
                tick={{ fontSize: 10 }}
                width={56}
              />
              <Tooltip
                formatter={(value) => [formatDuration(Number(value)), 'Est. makespan']}
                labelFormatter={(pct) => `${pct}% executors`}
              />
              <Line
                type="monotone"
                dataKey="estMakespanMs"
                name="Est. makespan"
                stroke={CHART_COLORS.accent}
                dot={{ r: 3 }}
              />
            </LineChart>
        </ChartFrame>
      </div>
    </WidgetCard>
  );
}
