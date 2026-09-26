import { memo, useMemo } from 'react';
import { Area, AreaChart, CartesianGrid, Tooltip, XAxis, YAxis } from 'recharts';

import { CHART_COLORS, CHART_TOOLTIP_BOX_STYLE, ChartFrame } from '@/view/charts/ChartTheme';
import { downsample } from '@/view/charts/downsample';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { AppModel } from '@sparkforensics/core/types.ts';

const HEIGHT = 220;

export type ExecutorCountChartProps = {
  appModel: AppModel;
  // Switching to a cached recent file mutates appModel's fields in place
  // rather than replacing the object, so this is a required memo key
  // alongside appModel.
  activeFileId?: string | null;
};

interface ExecutorSeries {
  times: string[];
  counts: number[];
}

function computeExecutorSeries(appModel: AppModel): ExecutorSeries {
  const app = appModel.app;
  const added = appModel.executors.added;
  const removed = appModel.executors.removed;
  // A missing endTime means an incomplete run (no ApplicationEnd event), not
  // "still running": substituting Date.now() would plot a fabricated,
  // ever-growing axis instead of self-hiding like every other whole-run chart
  // does on missing input (see CoreUsageArea's hasActivity guard).
  if (app?.startTime == null || app?.endTime == null) return { times: [], counts: [] };
  const duration = app.endTime - app.startTime;
  const step = Math.max(5000, Math.floor(duration / 100));
  const times: string[] = [];
  const counts: number[] = [];
  const removedAtMap = new Map(removed.map((r) => [r.executorId, r.timestamp]));
  for (let t = app.startTime; t <= app.endTime; t += step) {
    const active = added.filter((e) => {
      const removedAt = removedAtMap.get(e.executorId) ?? Infinity;
      return e.timestamp <= t && t < removedAt;
    }).length;
    times.push(((t - app.startTime) / 1000).toFixed(0) + 's');
    counts.push(active);
  }
  return { times, counts };
}

/** Executor add/remove count over time: a whole-run backdrop chart, not
 * driven by any finding. Extracted out of the former combined
 * `ExecutorTimeline.tsx`, which annotated this same chart with up to 5
 * finding types (now split into `SlowHost`, `StageSlowness`, `Straggler`,
 * `SpeculationWaste`, `ColdStart`); rendered directly in `ReferenceSection`,
 * not through `REGISTRY`. */
/** The chart's hover text on the theme's popover surface: "At 7s: Active
 * executors 2". */
export function ExecutorCountTooltip({ active, payload, label }: { active?: boolean; payload?: ReadonlyArray<{ value?: unknown }>; label?: unknown }) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={CHART_TOOLTIP_BOX_STYLE} data-testid="executor-count-tooltip">
      At {String(label)}: Active executors {String(payload[0].value)}
    </div>
  );
}

export const ExecutorCountChart = memo(function ExecutorCountChart({ appModel, activeFileId }: ExecutorCountChartProps) {
  const { chartData, sampled, hasSeries, peak } = useMemo(() => {
    const { times, counts } = computeExecutorSeries(appModel);
    const chartData = times.map((label, i) => ({ label, count: counts[i] }));
    const sampled = downsample(chartData);
    const hasSeries = counts.length > 0;
    const peak = hasSeries ? Math.max(...counts) : 0;
    return { chartData, sampled, hasSeries, peak };
  }, [appModel, activeFileId]);

  if (!hasSeries) {
    return (
      <WidgetCard
        title="Executor Count Over Time"
        summary={<span className="text-muted-foreground text-xs">Timeline unavailable: no end time recorded.</span>}
      >
        <p className="text-muted-foreground text-xs">
          This run has no ApplicationEnd event, so the executor timeline can&apos;t be plotted without fabricating an
          end time. See the Incomplete Run finding for what&apos;s still reliable.
        </p>
      </WidgetCard>
    );
  }

  return (
    <WidgetCard
      title="Executor Count Over Time"
      summary={<WidgetLeadSummary value={`${peak} peak`} context="concurrent executors" />}
    >
      <ChartFrame
        ariaLabel="Executor count over time. See the table below for exact values."
        height={HEIGHT}
        table={{
          caption: 'Executor timeline: active executor count over time',
          columns: ['Time', 'Active executors'],
          rows: chartData.map((r) => [r.label, r.count]),
          align: ['left', 'right'],
        }}
      >
        <AreaChart data={sampled}>
          <CartesianGrid vertical={false} stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
          <XAxis dataKey="label" tick={{ fontSize: 10 }} minTickGap={24} />
          <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={32} />
          {/* One line, "At 7s: Active executors 2": Recharts' default
              content would split it into a label and a "name : value" row. */}
          <Tooltip content={ExecutorCountTooltip} />
          {/* stepAfter: the count changes only when an executor is added or
              removed, so a smoothed curve would draw fractional executors. */}
          <Area
            type="stepAfter"
            dataKey="count"
            name="Active executors"
            stroke={CHART_COLORS.clean}
            fill={CHART_COLORS.clean}
            fillOpacity={0.15}
          />
        </AreaChart>
      </ChartFrame>
    </WidgetCard>
  );
});
