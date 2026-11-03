import { formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface ExecutorUtilizationRow extends WidgetRow<'utilization'> {
  finding: FindingOf<'utilization'>;
  /** The line above an evidence panel states the average; the row shows the measurements behind it. */
  stated: boolean;
}

export const executorUtilizationRows: RowsOf<'utilization', ExecutorUtilizationRow> = ({ findings, stated }) => (
  findings
    .map((finding): ExecutorUtilizationRow => ({ findings: [finding], finding, stated: isStated(finding, stated) }))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const executorUtilizationModel: FindingWidgetModel<'utilization', ExecutorUtilizationRow> = {
  type: 'utilization',
  rows: executorUtilizationRows,
  stageOf: () => null,
  summary: (rows) => ({ value: `${formatMetricValue('pct', numericValue(rows[0].finding))} average` }),
  listClassName: 'space-y-2 text-sm',
  rowClassName: 'space-y-2',
};
