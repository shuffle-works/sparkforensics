import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface AutoscalingChurnRow extends WidgetRow<'autoscalingChurn'> {
  finding: FindingOf<'autoscalingChurn'>;
  /** The line above an evidence panel states the short-lived share and the savings. */
  stated: boolean;
}

export const autoscalingChurnRows: RowsOf<'autoscalingChurn', AutoscalingChurnRow> = ({ findings, stated }) => (
  findings.map((finding) => ({ findings: [finding], finding, stated: isStated(finding, stated) }))
);

export const autoscalingChurnModel: FindingWidgetModel<'autoscalingChurn', AutoscalingChurnRow> = {
  type: 'autoscalingChurn',
  rows: autoscalingChurnRows,
  stageOf: () => null,
  listClassName: 'space-y-2',
  rowClassName: 'flex flex-col gap-1',
};
