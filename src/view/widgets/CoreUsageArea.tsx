import { memo, useMemo, useState } from 'react';
import { Inbox } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, Legend, Tooltip, XAxis, YAxis } from 'recharts';

import { computeCoreLocalityRatio } from '@sparkforensics/core/core-locality-ratio.ts';
import { buildLocalityChart, formatCores, type LocalityChartPoint } from '@sparkforensics/core/core-usage-locality.ts';
import { CHART_COLORS, CHART_TOOLTIP_PROPS, ChartFrame } from '@/view/charts/ChartTheme';
import { downsample } from '@/view/charts/downsample';
import type { WidgetProps } from '@/view/detector-registry';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { EmptyState } from '@/view/EmptyState';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { DocsLink } from '@/view/DocsContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';

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

// `applySnapshot` mutates `appModel`'s fields in place on a cached-file switch
// rather than replacing the object, so `activeFileId` is a memo key below.
// `catalog` is required: the `coreLocality` finding and the `memoryUtilization`
// idleCores cross-link both read it.
export type CoreUsageAreaProps = Pick<WidgetProps, 'appModel' | 'catalog' | 'activeFileId' | 'defaultCollapsed'>;

const TITLE = 'Core Usage by Locality';

type LocalityChartModel =
  | { hasActivity: false }
  | { hasActivity: true; order: string[]; points: AreaPoint[]; sampled: AreaPoint[]; peakCores: number };
type AreaPoint = LocalityChartPoint;

// memo: skip recomputing computeLocalityAreaSeries when only the finding filter
// changes. Always mounted by `Alerts.tsx`, so the `hasActivity`/finding branches
// below are the only gating this widget does on its own.
export const CoreUsageArea = memo(function CoreUsageArea({ appModel, catalog, activeFileId, defaultCollapsed = true }: CoreUsageAreaProps) {
  const [nonLocalPage, setNonLocalPage] = useState(0);
  // Whole derived-series pipeline (including the `hasActivity` guard) in one
  // `useMemo`; hooks run unconditionally, so the early return can't precede it.
  const chartModel: LocalityChartModel = useMemo(() => {
    const chart = buildLocalityChart([...appModel.stages.values()], appModel.app);
    return chart.hasActivity ? { ...chart, sampled: downsample(chart.points) } : chart;
  }, [appModel, activeFileId]);

  // Non-local-ratio aggregate + per-stage breakdown. Not gated on
  // `chartModel.hasActivity`: an app with locality data but no plottable
  // core-time window should still surface a real finding from `catalog`.
  const localityRatio = useMemo(
    // `topN: Infinity`: the default `TOP_N` bounds the aggregate's own
    // top-offenders slice, not the display; capping there would make this list
    // permanently shorter than `VISIBLE_LIMIT` and defeat pagination below.
    () => computeCoreLocalityRatio([...appModel.stages.values()], { topN: Infinity }),
    [appModel, activeFileId],
  );
  const coreLocalityFinding = catalog.find((f) => f.type === 'coreLocality');
  const idleCoresFlagged = catalog.some((f) => f.type === 'memoryUtilization' && f.variant === 'idleCores');

  // `topStages` excludes stages below minTasksPerStage even when they hold the
  // non-local tasks, so filter to rows that actually have non-local tasks rather
  // than gating on the aggregate. Computed before the `hasActivity` early return,
  // per rules of hooks.
  const nonLocalStages = localityRatio.topStages.filter((s) => s.nonLocalTasks > 0);
  const { totalPages: nonLocalTotalPages, effectivePage: nonLocalEffectivePage, visible: visibleNonLocalStages } =
    usePagedRows(nonLocalStages, nonLocalPage, setNonLocalPage);

  if (!chartModel.hasActivity) {
    return (
      <WidgetCard title={TITLE} summary={<span className="text-muted-foreground text-xs">No stage activity to plot.</span>}>
        <EmptyState tone="neutral" icon={Inbox} title="No stage activity to plot." />
      </WidgetCard>
    );
  }
  const { order, points, sampled, peakCores } = chartModel;

  return (
    <WidgetCard
      title={TITLE}
      impactBand={coreLocalityFinding?.impactBand}
      badges={coreLocalityFinding ? <TagBadge type="coreLocality" impactBand={coreLocalityFinding.impactBand} /> : null}
      defaultCollapsed={defaultCollapsed}
      summary={<WidgetLeadSummary value={`${formatCores(peakCores)} cores`} context="busy at the peak" />}
    >
      <div className="space-y-2">
        <AdvancedOnly>
          <p className="text-muted-foreground text-xs">
            approximate: stage-level attribution
            {!coreLocalityFinding ? (
              <>
                , see <DocsLink anchor="#bottleneck-utilization">how utilization is measured</DocsLink>
              </>
            ) : null}
          </p>
        </AdvancedOnly>
        {coreLocalityFinding ? (
          <p className="flex flex-wrap items-start gap-2 text-sm">
            <ImpactDot impactBand={coreLocalityFinding.impactBand} className="mt-1.5" />
            <span>
              <strong>{coreLocalityFinding.value}% non-local</strong>: {coreLocalityFinding.recommendation}
            </span>
          </p>
        ) : null}
        {coreLocalityFinding ? <ImpactEstimate finding={coreLocalityFinding} /> : null}
        <AdvancedOnly>
          {coreLocalityFinding ? (
            <RowStatusCluster confidence={coreLocalityFinding.confidence} validationRequired={coreLocalityFinding.validationRequired} />
          ) : null}
        </AdvancedOnly>
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
                tick={{ fontSize: 10 }}
                label={{ value: 'seconds from app start', position: 'insideBottom', offset: -2, fontSize: 10 }}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                width={36}
                label={{ value: 'avg concurrent cores', angle: -90, position: 'insideLeft', fontSize: 10 }}
              />
              <Tooltip {...CHART_TOOLTIP_PROPS} />
              <Legend wrapperStyle={{ fontSize: 10 }} />
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
        <AdvancedOnly>
          {visibleNonLocalStages.length > 0 ? (
            <>
              <ul className="space-y-1 text-xs text-muted-foreground">
                {visibleNonLocalStages.map((s) => (
                  <li key={s.stageId}>
                    Stage {s.stageId}: {Math.round(s.ratio * 100)}% non-local ({s.nonLocalTasks}/{s.taskCount} tasks)
                  </li>
                ))}
              </ul>
              <RowPagination
                page={nonLocalEffectivePage}
                totalPages={nonLocalTotalPages}
                onPrev={() => setNonLocalPage((p) => p - 1)}
                onNext={() => setNonLocalPage((p) => p + 1)}
              />
            </>
          ) : null}
        </AdvancedOnly>
        <AdvancedOnly>
          {idleCoresFlagged ? (
            <p className="text-xs text-muted-foreground">Idle cores also flagged → see Memory Utilization widget</p>
          ) : null}
        </AdvancedOnly>
      </div>
    </WidgetCard>
  );
});
