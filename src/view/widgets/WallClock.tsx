import { memo } from 'react';
import { Bar, BarChart, DefaultLegendContent, Legend, Tooltip, XAxis, YAxis } from 'recharts';

import { computeWallClock } from '@sparkforensics/core/wall-clock.ts';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { CHART_COLORS, ChartFrame } from '@/view/charts/ChartTheme';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { AdvancedOnly } from '@/view/AdvancedOnly';

export interface WallClockProps {
  appModel: AppModel;
}

interface Segment {
  key: string;
  label: string;
  value: number;
  color: string;
  fillOpacity: number;
  // Recharts' Legend icon ignores `fillOpacity`, so a faded bar segment (idle)
  // would otherwise show a full-opacity swatch; bake the opacity into the
  // color itself so the swatch matches the bar.
  legendColor: string;
}

// Thin single-row chart: no axes/grid to speak of, just the stacked bar plus
// its always-on Legend.
const HEIGHT = 64;

function legendColorFor(color: string, fillOpacity: number): string {
  return fillOpacity >= 1 ? color : `color-mix(in srgb, ${color} ${fillOpacity * 100}%, transparent)`;
}

// Segment colors: startup=info, active=clean, gaps=warning, idle=faint/muted.
function buildSegments(result: ReturnType<typeof computeWallClock>): Segment[] {
  return [
    { key: 'startup', label: 'Startup', value: result.startup, color: CHART_COLORS.info, fillOpacity: 1 },
    { key: 'stagesActive', label: 'Stages active', value: result.stagesActive, color: CHART_COLORS.clean, fillOpacity: 1 },
    { key: 'gaps', label: 'Scheduler gaps', value: result.gaps, color: CHART_COLORS.warning, fillOpacity: 1 },
    { key: 'idle', label: 'Idle', value: result.idle, color: CHART_COLORS.muted, fillOpacity: 0.6 },
  ]
    .filter((s) => s.value > 0)
    .map((s) => ({ ...s, legendColor: legendColorFor(s.color, s.fillOpacity) }));
}

/** Wall-clock-vs-compute bar: how the run's total wall-clock time splits across
 * startup, active stage execution, scheduler gaps, and idle time. Renders
 * nothing when there's no measurable wall-clock time (no completed stages and no
 * app start/end timestamps). */
// memo: appModel is reference-stable across board-filter toggles, so this
// always-mounted widget skips re-rendering when only the finding filter changes.
export const WallClock = memo(function WallClock({ appModel }: WallClockProps) {
  const { app, stages } = appModel;
  const result = computeWallClock(app, stages);
  if (result.total <= 0) return null;

  const segments = buildSegments(result);
  const pct = (n: number) => (result.total > 0 ? (n / result.total) * 100 : 0);
  const dominant = segments.reduce((a, b) => (b.value > a.value ? b : a), segments[0]);

  // A single synthetic row so Recharts' stacked-bar idiom draws one 100%-wide
  // horizontal bar; `stackOffset="expand"` normalizes each segment's raw
  // duration to its share of the row instead of us precomputing percentages.
  const chartData = [
    segments.reduce<Record<string, number | string>>((row, s) => ({ ...row, [s.key]: s.value }), { name: 'total' }),
  ];

  return (
    <WidgetCard
      title="Wall-Clock Breakdown"
      badges={<span className="text-xs text-muted-foreground">{formatDuration(result.total)} total</span>}
      summary={
        <WidgetLeadSummary
          value={`${dominant.label} ${Math.round(pct(dominant.value))}%`}
          context={`of ${formatDuration(result.total)} total`}
        />
      }
    >
      <ChartFrame
        ariaLabel={`Wall-clock breakdown: ${formatDuration(result.total)} total, split across startup, active stages, scheduler gaps and idle time. See the table below for exact values.`}
        height={HEIGHT}
        table={{
          caption: 'Wall-clock time breakdown',
          columns: ['Segment', 'Duration', '% of total'],
          rows: segments.map((s) => [s.label, formatDuration(s.value), `${Math.round(pct(s.value))}%`]),
          align: ['left', 'right', 'right'],
        }}
      >
        <BarChart
          data={chartData}
          layout="vertical"
          stackOffset="expand"
          margin={{ top: 0, right: 0, bottom: 0, left: 0 }}
        >
          <XAxis type="number" hide domain={[0, 1]} />
          <YAxis type="category" dataKey="name" hide />
          {/* `shared={false}` + a blank label: only the hovered segment shows, not
              the whole stack, so the tooltip is short enough to fit inside
              WidgetCard's clipped `overflow-hidden` panel (a `shared` tooltip
              for all 4 segments runs ~134px tall and gets cut off). */}
          <Tooltip shared={false} labelFormatter={() => ''} formatter={(value, name) => [formatDuration(Number(value)), name]} />
          <Legend
            wrapperStyle={{ fontSize: 12 }}
            // Recharts' default itemSorter is an alphabetical sort by label
            // ('value'), which for these four specific labels happens to come
            // out reversed relative to the bar; `itemSorter` re-ranks the
            // computed payload to match `segments`' actual order (recharts
            // 3.x's <Legend> no longer accepts a `payload` prop directly,
            // passing one to a custom `content` element gets clobbered, since
            // Recharts clones that element with its own computed props). The
            // computed payload's color also just echoes each <Bar fill>,
            // ignoring fillOpacity, so remap it to `legendColor` (idle's
            // baked-opacity color) for the icon before delegating to the
            // default legend renderer. DefaultLegendContent also uses that
            // same color for the label text, so a `formatter` restores the
            // text to full-strength color: a faded icon is fine, faded 12px
            // text fails WCAG AA contrast.
            itemSorter={(item) => segments.findIndex((s) => s.key === item.dataKey)}
            formatter={(value, entry) => {
              const seg = segments.find((s) => s.key === entry.dataKey);
              return <span style={{ color: seg?.color }}>{value}</span>;
            }}
            content={(props) => (
              <DefaultLegendContent
                {...props}
                payload={props.payload?.map((p) => {
                  const seg = segments.find((s) => s.key === p.dataKey);
                  return seg ? { ...p, color: seg.legendColor } : p;
                })}
              />
            )}
          />
          {segments.map((s) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="wallclock" fill={s.color} fillOpacity={s.fillOpacity} />
          ))}
        </BarChart>
      </ChartFrame>
      <AdvancedOnly>
        <div className="mt-3 flex flex-wrap gap-3 text-xs text-muted-foreground">
          {segments.map((s) => (
            <span key={s.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block size-2.5 rounded-sm"
                style={{ backgroundColor: s.color, opacity: s.fillOpacity }}
              />
              {s.label} ({formatDuration(s.value)})
            </span>
          ))}
        </div>
      </AdvancedOnly>
    </WidgetCard>
  );
});
