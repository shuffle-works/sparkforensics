import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface StageFailedRow extends WidgetRow<'stageFailed'> {
  finding: FindingOf<'stageFailed'>;
  stageId: number;
  /** The line above an evidence panel states the stage and the fact of the failure; only the reason remains. */
  stated: boolean;
}

export const stageFailedRows: RowsOf<'stageFailed', StageFailedRow> = ({ findings, stated }) => (
  findings
    .flatMap((finding) => (
      finding.stageId == null ? [] : [{ findings: [finding], finding, stageId: finding.stageId, stated: isStated(finding, stated) }]
    ))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand] || a.stageId - b.stageId)
);

export const stageFailedModel: FindingWidgetModel<'stageFailed', StageFailedRow> = {
  type: 'stageFailed',
  rows: stageFailedRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({ value: rows.length, context: `stage${rows.length === 1 ? '' : 's'} failed outright` }),
  rowElement: 'li',
  rowClassName: 'flex flex-col gap-1',
};
