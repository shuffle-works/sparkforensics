import { useMemo } from 'react';
import { Inbox } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';

import type { LocalityChartPoint } from '@sparkforensics/core/core-usage-locality.ts';
import { formatCores } from '@sparkforensics/core/format-utils.ts';
import { useInterpretation } from '@/view/interpretation';
import { CHART_COLORS, CHART_TOOLTIP_PROPS, ChartFrame } from '@/view/charts/ChartTheme';
import { downsample } from '@/view/charts/downsample';
import { EmptyState } from '@/view/EmptyState';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { DocsLink } from '@/view/DocsContext';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot } from '@/view/ImpactBadge';
import { NonLocalStageList } from './NonLocalStageList';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { chartShowsTrend, coreUsageModel, type CoreUsageRow } from './CoreUsageArea.rows';

// Stacked-area cluster shape by locality tier over time (approximate).
const HEIGHT = 240;

// Raw Spark locality enum names read as internal identifiers, so humanize them
// for the legend/tooltip; `order`/series keys stay raw so series lookups work.
const TIER_LABEL: Record<string, string> = {
  PROCESS_LOCAL: 'Process-local',
  NODE_LOCAL: 'Node-local',
  RACK_LOCAL: 'Rack-local',
  NO_PREF: 'No preference',
  ANY: 'Any',
  OTHER: 'Other',
  idle: 'Idle',
};

const TIER_COLOR: Record<string, string> = {
  PROCESS_LOCAL: CHART_COLORS.clean,
  NODE_LOCAL: CHART_COLORS.accent,
  RACK_LOCAL: CHART_COLORS.warning,
  NO_PREF: CHART_COLORS.muted,
  ANY: CHART_COLORS.critical,
  OTHER: CHART_COLORS.muted,
  idle: CHART_COLORS.muted,
};

type ActiveLocalityChart = { hasActivity: true; order: string[]; points: AreaPoint[]; sampled: AreaPoint[]; peakCores: number };
type LocalityChartModel = { hasActivity: false } | ActiveLocalityChart;
type AreaPoint = LocalityChartPoint;

/** The locality chart's model, from the store's interpretation. */
export function useLocalityChartModel(): LocalityChartModel {
  const chart = useInterpretation()?.data.coreLocality?.chart ?? { hasActivity: false as const };
  return useMemo(() => (chart.hasActivity ? { ...chart, sampled: downsample(chart.points) } : chart), [chart]);
}

/** Whether an evidence panel embeds the chart: the run has activity and enough points for a trend. */
export const panelShowsChart = (model: LocalityChartModel): model is ActiveLocalityChart => chartShowsTrend(model);

/** Concurrent core usage over time, stacked by locality tier, with idle capacity. */
export function CoreUsageChart({ model: { order, points, sampled } }: { model: ActiveLocalityChart }) {
  return (
    <ChartFrame
      ariaLabel="Approximate concurrent core usage over time, stacked by task locality tier, with idle capacity shown. See the legend for tier colors."
      height={HEIGHT}
      table={{
        caption: 'Concurrent core usage over time by locality tier',
        columns: ['Time (s)', ...order.map((tier) => TIER_LABEL[tier] ?? tier)],
        rows: points.map((p) => [p.t, ...order.map((tier) => Math.round(p[tier]))]),
        align: Array.from({ length: order.length + 1 }, () => 'right'),
      }}
    >
      <AreaChart data={sampled}>
        <CartesianGrid vertical={false} stroke={CHART_COLORS.muted} strokeOpacity={0.2} />
        <XAxis
          dataKey="t"
          tick={{ fontSize: 11 }}
          // Unit on the ticks, not an axis title: the title collided with the legend.
          tickFormatter={(value) => `${value}s`}
        />
        <YAxis
          tick={{ fontSize: 11 }}
          width={36}
          label={{ value: 'avg concurrent cores', angle: -90, position: 'insideLeft', fontSize: 12 }}
        />
        <Tooltip
          {...CHART_TOOLTIP_PROPS}
          labelFormatter={(label) => `${label}s from app start`}
          // Bucket averages are fractional cores; two decimals is the readable precision.
          formatter={(value) => (typeof value === 'number' ? value.toFixed(2) : String(value))}
        />
        <Legend wrapperStyle={{ fontSize: 12 }} />
        {order.map((tier) => (
          <Area
            key={tier}
            type="monotone"
            dataKey={tier}
            name={TIER_LABEL[tier] ?? tier}
            stackId="cores"
            stroke={TIER_COLOR[tier] ?? CHART_COLORS.muted}
            fill={TIER_COLOR[tier] ?? CHART_COLORS.muted}
            fillOpacity={tier === 'idle' ? 0.15 : 0.8}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ChartFrame>
  );
}

function Row({ row: { finding, stated, showStatus } }: FindingRowProps<CoreUsageRow>) {
  return (
    <>
      {stated ? null : (
        <p className="flex flex-wrap items-start gap-2 text-sm">
          <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
          <strong>{finding.value}% non-local</strong>
        </p>
      )}
      {stated ? null : <ImpactEstimate finding={finding} />}
      {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
    </>
  );
}

/** The chart, and the Advanced notes around it: the attribution caveat, the stages with non-local
 * tasks, and the pointer to Memory Utilization when idle cores are flagged. */
const Lead: NonNullable<FindingWidgetView<CoreUsageRow>['Lead']> = ({ catalog, rows, density }) => {
  const coreLocality = useInterpretation()?.data.coreLocality;
  const chartModel = useLocalityChartModel();

  // `topStages` excludes stages below minTasksPerStage even when they hold the
  // non-local tasks, so filter to rows that actually have non-local tasks rather
  // than gating on the aggregate.
  const nonLocalStages = (coreLocality?.ratio.topStages ?? []).filter((s) => s.nonLocalTasks > 0);

  if (!chartModel.hasActivity) return <EmptyState tone="neutral" icon={Inbox} title="No stage activity to plot." />;

  const advanced = density === 'advanced';
  const idleCoresFlagged = catalog.some((f) => f.type === 'memoryUtilization' && f.variant === 'idleCores');

  return (
    <div className="space-y-2">
      {advanced ? (
        <p className="text-muted-foreground text-xs">
          approximate: stage-level attribution
          {rows.length === 0 ? (
            <>
              , see <DocsLink anchor="#bottleneck-utilization">how utilization is measured</DocsLink>
            </>
          ) : null}
        </p>
      ) : null}
      <CoreUsageChart model={chartModel} />
      {advanced ? <NonLocalStageList stages={nonLocalStages} /> : null}
      {advanced && idleCoresFlagged ? (
        <p className="text-xs text-muted-foreground">Idle cores also flagged → see Memory Utilization widget</p>
      ) : null}
    </div>
  );
};

// Reads the interpretation's chart directly: the chart model's downsampling belongs to the `Lead`, once.
const Summary: NonNullable<FindingWidgetView<CoreUsageRow>['Summary']> = () => {
  const chart = useInterpretation()?.data.coreLocality?.chart;
  return chart?.hasActivity
    ? <WidgetLeadSummary value={`${formatCores(chart.peakCores)} cores`} context="busy at the peak" />
    : <span className="text-muted-foreground text-xs">No stage activity to plot.</span>;
};

/** Core usage over time by locality tier. Always mounted on the Full app report (see
 * `isAlwaysMountedType`): the chart is the tile, and the `coreLocality` finding adds its row. */
export const CoreUsageArea = defineFindingWidget(coreUsageModel, { Row, Lead, Summary });
