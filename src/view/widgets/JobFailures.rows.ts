import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface JobFailuresRow extends WidgetRow<'jobFailureRate'> {
  finding: FindingOf<'jobFailureRate'>;
  /** The line above an evidence panel states the failed and total job counts. */
  stated: boolean;
  /** Advanced density adds the task-level failure context. */
  showTaskContext: boolean;
}

// The rollup is app-scoped: one row, for the first finding.
export const jobFailuresRows: RowsOf<'jobFailureRate', JobFailuresRow> = ({ findings, stated, density }) => (
  findings.slice(0, 1).map((finding) => ({
    findings: [finding],
    finding,
    stated: isStated(finding, stated),
    showTaskContext: density === 'advanced',
  }))
);

export const jobFailuresModel: FindingWidgetModel<'jobFailureRate', JobFailuresRow> = {
  type: 'jobFailureRate',
  rows: jobFailuresRows,
  stageOf: () => null,
  summary: ([{ finding }]) => ({
    value: `${finding.value}%`,
    context: `${finding.failedJobs} of ${finding.totalJobs} completed jobs failed`,
  }),
  rowClassName: 'flex flex-col gap-1',
};
