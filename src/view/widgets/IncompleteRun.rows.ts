import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import type { FindingOf } from '@sparkforensics/core/types.ts';

export interface IncompleteRunRow extends WidgetRow<'incompleteRun'> {
  finding: FindingOf<'incompleteRun'>;
}

// The line above an evidence panel states the missing event, so a stated finding has no row.
export const incompleteRunRows: RowsOf<'incompleteRun', IncompleteRunRow> = ({ findings, stated }) => (
  findings
    .filter((finding) => !isStated(finding, stated))
    .slice(0, 1)
    .map((finding) => ({ findings: [finding], finding }))
);

export const incompleteRunModel: FindingWidgetModel<'incompleteRun', IncompleteRunRow> = {
  type: 'incompleteRun',
  rows: incompleteRunRows,
  stageOf: () => null,
  rowClassName: 'flex flex-col gap-1',
};
