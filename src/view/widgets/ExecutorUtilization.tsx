import { memo, useMemo, useState } from 'react';

import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { useStatedAbove } from '@/view/InlineEvidenceContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { useAnchoredRow } from '@/view/finding-anchor';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { formatCores, formatDuration, formatMetricValue, formatRawWaste, IMPACT_BAND_ORDER, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { CoreUsageChart, panelShowsChart, useLocalityChartModel } from './CoreUsageArea';

export type ExecutorUtilizationProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

const coreTime = (value: number) => formatRawWaste({ value, unit: 'coreMs' });

function UtilizationRow({ finding }: { finding: FindingOf<'utilization'> }) {
  const anchor = useAnchoredRow([finding]);
  const stated = useStatedAbove(finding);
  const chart = useLocalityChartModel();
  const { allocatedCoreMs, utilizationFraction, totalCores, appDurationMs, cpuUtilizationPct } = finding;

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`${stated ? 'space-y-2 ' : ''}transition-colors ${anchor.flashClassName}`}
    >
      {/* The line above an evidence panel states the average. */}
      {stated ? null : (
        <p className="flex flex-wrap items-start gap-2">
          <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
          <strong>{formatMetricValue('pct', numericValue(finding))}</strong> average executor utilization
        </p>
      )}
      {stated ? (
        <p className="text-xs text-muted-foreground">
          {formatCores(totalCores)} cores at peak over {formatDuration(appDurationMs)}: {coreTime(allocatedCoreMs)} allocated,{' '}
          {coreTime(allocatedCoreMs * utilizationFraction)} busy, {coreTime(allocatedCoreMs * (1 - utilizationFraction))} idle
          {cpuUtilizationPct != null ? `. CPU time was ${cpuUtilizationPct}% of the allocation.` : '.'}
        </p>
      ) : null}
      {stated && panelShowsChart(chart) ? <CoreUsageChart model={chart} /> : null}
      <ImpactEstimate finding={finding} />
    </div>
  );
}

/** Average executor CPU utilization across the run. `utilization` is a
 * `reference`-region type excluded from always-mounted status (see
 * `ALWAYS_MOUNTED_EXCEPTIONS` in `detector-registry.tsx`): like an ordinary
 * action widget, it returns `null` with no findings and collapses to a
 * `CleanCheckRow` instead. */
export const ExecutorUtilization = memo(function ExecutorUtilization({ catalog, defaultCollapsed = true }: ExecutorUtilizationProps) {
  const [page, setPage] = useState(0);

  const findings = useMemo(
    () =>
      catalog
        .filter((f) => f.type === 'utilization')
        .slice()
        .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]),
    [catalog],
  );
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Executor Utilization"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      badges={<TagBadge type="utilization" impactBand={worstImpactBand(findings) ?? 'info'} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${formatMetricValue('pct', numericValue(findings[0]))} average`}
          context={findingCount(findings.length)}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {visible.map((f) => (
          <UtilizationRow key={f.id} finding={f} />
        ))}
      </div>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
