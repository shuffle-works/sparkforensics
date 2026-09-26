import { Bar, BarChart, CartesianGrid, ReferenceLine, Tooltip, XAxis, YAxis } from 'recharts';

import { buildHistogram } from '@sparkforensics/core/format-utils.ts';
import { CHART_COLORS, CHART_TOOLTIP_PROPS, ChartFrame } from './ChartTheme';

const MIN_HISTOGRAM_TASKS = 5;
const HISTOGRAM_BINS = 30;
const HEIGHT = 220;

export interface DurationHistogramMarkers {
  p50?: number;
  p95?: number;
}

export interface DurationHistogramProps {
  metrics: Float64Array | number[];
  fieldNames: string[];
  markers?: DurationHistogramMarkers;
}

interface HistogramRow {
  bin: string;
  range: string;
  ms: number;
  count: number;
}

function nearestBinMs(labels: number[], value: number): number | null {
  if (labels.length < 2) return labels[0] ?? null;
  const binSize = labels[1] - labels[0];
  const idx = Math.round((value - labels[0]) / binSize);
  return labels[Math.min(labels.length - 1, Math.max(0, idx))];
}

export function DurationHistogram({ metrics, fieldNames, markers = {} }: DurationHistogramProps) {
  const durationIdx = fieldNames.indexOf('duration');
  if (durationIdx === -1) return null;

  const stride = fieldNames.length;
  const taskCount = metrics.length / stride;
  const durations: number[] = [];
  for (let i = 0; i < taskCount; i++) durations.push(metrics[i * stride + durationIdx]);

  if (durations.length < MIN_HISTOGRAM_TASKS) {
    return (
      <p className="text-muted-foreground text-xs">
        Too few tasks ({durations.length}) for a distribution.
      </p>
    );
  }

  const { labels, data } = buildHistogram(durations, HISTOGRAM_BINS) as { labels: number[]; data: number[] };
  const binWidthMs = labels[1] - labels[0];
  const rows: HistogramRow[] = labels.map((ms, i) => ({
    bin: `${(ms / 1000).toFixed(1)}s`,
    range: `${(ms / 1000).toFixed(1)}s – ${((ms + binWidthMs) / 1000).toFixed(1)}s`,
    ms,
    count: data[i],
  }));

  const p50Ms = markers.p50 != null ? nearestBinMs(labels, markers.p50) : null;
  const p95Ms = markers.p95 != null ? nearestBinMs(labels, markers.p95) : null;
  const p50Bin = p50Ms != null ? rows.find((row) => row.ms === p50Ms)?.bin : undefined;
  const p95Bin = p95Ms != null ? rows.find((row) => row.ms === p95Ms)?.bin : undefined;

  return (
    <ChartFrame
      title="Task duration"
      ariaLabel="Task duration histogram"
      height={HEIGHT}
      table={{
        caption: 'Task duration histogram',
        columns: ['Duration bin', 'Task count'],
        rows: rows.map((r) => [r.range, r.count]),
        align: ['right', 'right'],
      }}
    >
      <BarChart data={rows}>
        <CartesianGrid vertical={false} stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
        <XAxis dataKey="bin" tick={{ fontSize: 10 }} />
        <YAxis allowDecimals={false} tick={{ fontSize: 10 }} width={32} />
        <Tooltip
          {...CHART_TOOLTIP_PROPS}
          formatter={(value) => [`${Number(value)} task${Number(value) === 1 ? '' : 's'}`, 'Count']}
          labelFormatter={(label, payload) => (payload?.[0]?.payload as HistogramRow | undefined)?.range ?? label}
        />
        <Bar dataKey="count" name="Tasks" fill={CHART_COLORS.accent} />
        {p50Bin ? <ReferenceLine x={p50Bin} stroke={CHART_COLORS.accent} label="P50" /> : null}
        {p95Bin ? <ReferenceLine x={p95Bin} stroke={CHART_COLORS.warning} label="P95" /> : null}
      </BarChart>
    </ChartFrame>
  );
}
