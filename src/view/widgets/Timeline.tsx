import { useState } from 'react';
import { Inbox } from 'lucide-react';
import { Bar, BarChart, CartesianGrid, Cell, Tooltip, XAxis, YAxis } from 'recharts';

import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import type { AppModel, Finding, Stage } from '@sparkforensics/core/types.ts';
import { CHART_COLORS, ChartFrame } from '@/view/charts/ChartTheme';
import { downsample } from '@/view/charts/downsample';
import { EmptyState } from '@/view/EmptyState';
import { useStageDetail } from '@/view/StageDetailContext';
import { useWidgetDensity } from '@/store/store';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';

const TIMELINE_TOP_N = 20;
// Per-category row height for the y-axis. A fixed 320px chart at 20 rows
// packed labels 14px apart and made every "Stage N" caption unreadable;
// 24px is the measured gap that keeps a 10px label legible against its
// neighbors. Chart height scales with row count instead of staying fixed.
const ROW_HEIGHT = 24;
// px the x-axis line, its ticks, and Recharts' default margins consume below
// the category rows — the plot area is shorter than the chart's own height.
const AXIS_CHROME = 40;
const MIN_CHART_HEIGHT = 200;
const MAX_CHART_HEIGHT = 640;

interface SelectedTimelineStages {
  stages: Stage[];
  total: number;
  capped: boolean;
}

// A one-bar-per-stage Gantt is unreadable past a few dozen rows, so cap to the
// top-N longest stages, then restore chronological order for display.
export function selectTimelineStages(
  allStages: Stage[],
  topN: number = TIMELINE_TOP_N,
): SelectedTimelineStages {
  const valid = [...allStages].filter((s) => s.submittedAt && s.completedAt);
  const total = valid.length;
  if (total <= topN) {
    return { stages: valid.sort((a, b) => a.submittedAt! - b.submittedAt!), total, capped: false };
  }
  const top = [...valid]
    .sort((a, b) => (b.completedAt! - b.submittedAt!) - (a.completedAt! - a.submittedAt!))
    .slice(0, topN)
    .sort((a, b) => a.submittedAt! - b.submittedAt!);
  return { stages: top, total, capped: true };
}

export type TimelineProps = { appModel: AppModel; catalog: Finding[] };

interface TimelineRow {
  stageId: number;
  label: string;
  wait: number;
  duration: number;
  flagged: boolean;
}

export function Timeline({ appModel, catalog }: TimelineProps) {
  const { openStage } = useStageDetail();
  const allStages = [...appModel.stages.values()].filter((s) => s.submittedAt && s.completedAt);
  const total = allStages.length;
  const earliest = allStages.reduce((m, s) => Math.min(m, s.submittedAt!), Infinity);
  const appStart = (appModel.app?.startTime as number | undefined) ?? (Number.isFinite(earliest) ? earliest : 0);
  const flagged = new Set(catalog.filter((f) => f.stageId != null).map((f) => f.stageId));

  const density = useWidgetDensity();
  // Density only picks the starting point: Basic opens capped to the fixed
  // top-N, Advanced opens showing every stage. Seeded once on mount (like
  // WidgetCard's own uncontrolled open state) so a later density toggle
  // doesn't clobber a manual edit made via the input below.
  const [topN, setTopN] = useState(() => (density === 'advanced' ? total : TIMELINE_TOP_N));

  const { stages } = selectTimelineStages(allStages, topN);
  // Even if the user raises topN past a legible bar count, downsample the series
  // handed to the chart (Recharts renders one SVG node per bar).
  const sampled = downsample(stages);

  const rows: TimelineRow[] = sampled.map((s) => ({
    stageId: s.id,
    label: `Stage ${s.id}`,
    wait: s.submittedAt! - appStart,
    duration: s.completedAt! - s.submittedAt!,
    flagged: flagged.has(s.id),
  }));

  // Grow the chart with the row count so every label gets a full ROW_HEIGHT
  // of vertical space, up to MAX_CHART_HEIGHT; past that cap, fall back to
  // thinning labels so the ones still shown stay ROW_HEIGHT apart. Thin via
  // `tickFormatter` (blanking skipped labels), not the YAxis `interval` prop,
  // whose skip anchors to the last tick and drops the first stage's label;
  // indexing from 0 keeps the first stage's label visible.
  const height = Math.min(
    MAX_CHART_HEIGHT,
    Math.max(MIN_CHART_HEIGHT, rows.length * ROW_HEIGHT + AXIS_CHROME),
  );
  const plotHeight = height - AXIS_CHROME;
  const maxVisibleYLabels = Math.max(1, Math.floor(plotHeight / ROW_HEIGHT));
  const yAxisLabelStride = Math.max(1, Math.ceil(rows.length / maxVisibleYLabels));

  return (
    <WidgetCard
      title="Job Timeline"
      summary={
        total > 0 ? (
          <WidgetLeadSummary
            value={`${total} stage${total === 1 ? '' : 's'}`}
            context={`${flagged.size} flagged`}
          />
        ) : undefined
      }
    >
      {total === 0 ? (
        <EmptyState tone="neutral" icon={Inbox} title="No stages in this run." />
      ) : (
        <>
          <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
            <label htmlFor="timeline-topn">showing top</label>
            <input
              id="timeline-topn"
              type="number"
              min={1}
              max={total}
              value={Math.min(topN, total)}
              onChange={(e) => {
                let v = parseInt(e.target.value, 10);
                if (!Number.isFinite(v)) v = topN;
                setTopN(Math.max(1, Math.min(total, v)));
              }}
              className="w-16 rounded border border-input bg-transparent px-1 py-0.5"
              aria-label="Number of stages to show"
            />
            <span>of {total} by duration · flagged in red</span>
          </div>
          <ChartFrame
            ariaLabel="Job timeline: stage durations by time from app start."
            height={height}
            table={{
              caption: 'Job timeline: stage durations by time from app start',
              columns: ['Stage', 'Start', 'Duration'],
              rows: rows.map((r) => [r.label, formatDuration(r.wait), formatDuration(r.duration)]),
              align: ['left', 'right', 'right'],
            }}
          >
              <BarChart data={rows} layout="vertical">
                <CartesianGrid stroke={CHART_COLORS.muted} strokeOpacity={0.2} horizontal={false} />
                <XAxis
                  type="number"
                  tickFormatter={(v: number) => `${Math.round(v / 1000)}s`}
                  tick={{ fontSize: 10 }}
                  tickCount={10}
                />
                <YAxis
                  type="category"
                  dataKey="label"
                  tick={{ fontSize: 10 }}
                  width={64}
                  interval={0}
                  tickFormatter={(value: string, index: number) => (index % yAxisLabelStride === 0 ? value : '')}
                />
                <Tooltip
                  formatter={(value, name) => (name === 'Duration' ? formatDuration(Number(value)) : [null, null])}
                />
                <Bar dataKey="wait" stackId="timeline" fill="transparent" name="Wait" />
                <Bar
                  dataKey="duration"
                  stackId="timeline"
                  name="Duration"
                  cursor="pointer"
                  onClick={(data) => openStage((data.payload as TimelineRow).stageId)}
                >
                  {rows.map((r) => (
                    <Cell
                      key={r.stageId}
                      fill={r.flagged ? CHART_COLORS.critical : CHART_COLORS.accent}
                      stroke={r.flagged ? CHART_COLORS.critical : 'none'}
                      strokeWidth={r.flagged ? 2 : 0}
                    />
                  ))}
                </Bar>
              </BarChart>
          </ChartFrame>
        </>
      )}
    </WidgetCard>
  );
}
