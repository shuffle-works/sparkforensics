import { ImpactDot } from '@/view/ImpactBadge';
import { defineFindingWidget, type FindingRowProps } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { formatCores, formatDuration, formatMetricValue, formatRawWaste, numericValue } from '@sparkforensics/core/format-utils.ts';
import { CoreUsageChart, panelShowsChart, useLocalityChartModel } from './CoreUsageArea';
import { executorUtilizationModel, type ExecutorUtilizationRow } from './ExecutorUtilization.rows';

const coreTime = (value: number) => formatRawWaste({ value, unit: 'coreMs' });

function Row({ row: { finding, stated } }: FindingRowProps<ExecutorUtilizationRow>) {
  const chart = useLocalityChartModel();
  const { allocatedCoreMs, utilizationFraction, totalCores, appDurationMs, cpuUtilizationPct } = finding;

  if (!stated) {
    return (
      <>
        <p className="flex flex-wrap items-start gap-2">
          <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
          <strong>{formatMetricValue('pct', numericValue(finding))}</strong> average executor utilization
        </p>
        <ImpactEstimate finding={finding} />
      </>
    );
  }
  return (
    <>
      <p className="text-xs text-muted-foreground">
        {formatCores(totalCores)} cores at peak over {formatDuration(appDurationMs)}: {coreTime(allocatedCoreMs)} allocated,{' '}
        {coreTime(allocatedCoreMs * utilizationFraction)} busy, {coreTime(allocatedCoreMs * (1 - utilizationFraction))} idle
        {cpuUtilizationPct != null ? `. CPU time was ${cpuUtilizationPct}% of the allocation.` : '.'}
      </p>
      {panelShowsChart(chart) ? <CoreUsageChart model={chart} /> : null}
    </>
  );
}

/** Average executor CPU utilization across the run. */
export const ExecutorUtilization = defineFindingWidget(executorUtilizationModel, { Row });
