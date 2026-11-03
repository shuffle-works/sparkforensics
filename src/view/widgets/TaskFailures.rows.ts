import { formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface TaskFailuresRow extends WidgetRow<'failures'> {
  finding: FindingOf<'failures'>;
  stageId: number;
  /** The line above an evidence panel states the rate and the dominant error; only the task count remains. */
  stated: boolean;
  dominantError: string | null;
}

export const taskFailuresRows: RowsOf<'failures', TaskFailuresRow> = ({ findings, stated }) => (
  findings
    .flatMap((finding) => (
      finding.stageId == null ? [] : [{
        findings: [finding],
        finding,
        stageId: finding.stageId,
        stated: isStated(finding, stated),
        dominantError: finding.dominantError ?? finding.dominantReason ?? null,
      }]
    ))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand] || a.stageId - b.stageId)
);

export const taskFailuresModel: FindingWidgetModel<'failures', TaskFailuresRow> = {
  type: 'failures',
  rows: taskFailuresRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({ value: formatMetricValue('pct', numericValue(rows[0].finding)) }),
  rowElement: 'li',
  rowClassName: 'flex flex-col gap-1',
};
