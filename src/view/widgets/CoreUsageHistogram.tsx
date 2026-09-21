import { useEffect, useState } from 'react';
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from 'recharts';

import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { computeCoreTimeSeries } from '@sparkforensics/core/core-time-series.ts';
import type { AppModel, TaskData } from '@sparkforensics/core/types.ts';
import { useLiveTaskData } from '@/view/useLiveTaskData';
import { CHART_COLORS, ChartFrame } from '../charts/ChartTheme';
import { downsample } from '../charts/downsample';
import { DocsLink } from '../DocsContext';
import { WidgetCard } from '../WidgetCard';
import { WidgetLeadSummary } from '../WidgetLeadSummary';

const HEIGHT = 220;

interface TaskInterval {
  launch: number;
  finish: number;
}

/** Flattens per-stage task data into the launch/finish interval list
 * `computeCoreTimeSeries` expects. */
export async function gatherTaskIntervals(
  appModel: AppModel,
  getTaskData: (id: number) => Promise<TaskData>,
): Promise<{ intervals: TaskInterval[]; incomplete: boolean }> {
  const ids = [...appModel.stages.keys()];
  const results = await Promise.all(ids.map((id) => getTaskData(id).catch(() => null)));
  const intervals: TaskInterval[] = [];
  let incomplete = false;
  for (const data of results) {
    if (!data) {
      incomplete = true;
      continue;
    }
    const { metrics, fieldNames } = data;
    const stride = fieldNames.length;
    const li = fieldNames.indexOf('launchTime');
    const fi = fieldNames.indexOf('finishTime');
    if (li === -1 || fi === -1) continue;
    for (let i = 0; i < metrics.length; i += stride) {
      intervals.push({ launch: metrics[i + li], finish: metrics[i + fi] });
    }
  }
  return { intervals, incomplete };
}

interface HistogramRow {
  cores: string;
  coreCount: number;
  ms: number;
}

export interface CoreUsageHistogramProps {
  appModel: AppModel;
  getTaskData: (id: number) => Promise<TaskData>;
}

export function CoreUsageHistogram({ appModel, getTaskData }: CoreUsageHistogramProps) {
  const { exportMode, getTaskData: liveGetTaskData } = useLiveTaskData(getTaskData);
  const [histogram, setHistogram] = useState<number[] | null>(null);
  const [incomplete, setIncomplete] = useState(false);
  // Controlled disclosure so the task-data fetch below can be gated on the card
  // actually being open.
  const [open, setOpen] = useState(false);
  const hasStages = appModel.stages.size > 0;

  useEffect(() => {
    if (!hasStages || !open || histogram !== null || !liveGetTaskData) return;
    let cancelled = false;
    gatherTaskIntervals(appModel, liveGetTaskData).then(({ intervals, incomplete: inc }) => {
      if (cancelled) return;
      const { histogram: hist } = computeCoreTimeSeries(intervals, { bucketBy: 'coreCount' }) as { mode: 'coreCount'; histogram: number[] };
      setHistogram(hist ?? []);
      setIncomplete(inc);
    });
    return () => {
      cancelled = true;
    };
  }, [appModel, liveGetTaskData, hasStages, open, histogram]);

  if (!hasStages) return null;

  const rows: HistogramRow[] = (histogram ?? []).map((ms, coreCount) => ({
    cores: String(coreCount),
    coreCount,
    ms,
  }));
  const sampled = downsample(rows);
  const busiest = rows.reduce((a, b) => (b.ms > a.ms ? b : a), rows[0]);

  return (
    <WidgetCard
      title="Core-Usage Distribution"
      id="core-usage-histogram"
      open={open}
      onOpenChange={setOpen}
      summary={
        histogram !== null && busiest ? (
          <WidgetLeadSummary
            value={formatDuration(busiest.ms)}
            context={`at ${busiest.coreCount} concurrent core${busiest.coreCount === 1 ? '' : 's'}`}
          />
        ) : undefined
      }
    >
      {histogram === null ? (
        exportMode ? (
          <p className="text-muted-foreground text-xs">Core-usage detail isn&rsquo;t included in exported reports.</p>
        ) : (
          <p className="text-muted-foreground text-xs">Loading core usage…</p>
        )
      ) : (
        <>
          <ChartFrame
            ariaLabel="Wall-clock time spent at each concurrent-core count across the run. See the table below for exact values."
            height={HEIGHT}
            table={{
              caption: 'Wall-clock time by concurrent-core count',
              columns: ['Concurrent cores', 'Time'],
              rows: histogram.map((ms, coreCount) => [coreCount, formatDuration(ms)]),
              align: ['right', 'right'],
            }}
          >
            <BarChart data={sampled}>
              <CartesianGrid vertical={false} stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
              <XAxis
                dataKey="cores"
                tick={{ fontSize: 10 }}
                label={{ value: 'Concurrent busy cores', position: 'insideBottom', offset: -5, fontSize: 10 }}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                width={48}
                tickFormatter={(value: number) => formatDuration(value)}
              />
              <Bar dataKey="ms" name="Time" fill={CHART_COLORS.accent} />
            </BarChart>
          </ChartFrame>
          {incomplete ? (
            <p className="text-muted-foreground text-xs">
              Reopen this file to compute full core usage because some task data was released.
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            See <DocsLink anchor="#bottleneck-utilization">how to read concurrent-core utilization</DocsLink>.
          </p>
        </>
      )}
    </WidgetCard>
  );
}
