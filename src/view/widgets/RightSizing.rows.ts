import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface RightSizingRow extends WidgetRow<'rightSizing'> {
  finding: FindingOf<'rightSizing'>;
  /** The line above an evidence panel states the core counts and both durations. */
  stated: boolean;
  /** The model error, shown at Advanced only. */
  showModelError: boolean;
}

export const rightSizingRows: RowsOf<'rightSizing', RightSizingRow> = ({ findings, stated, density }) => (
  findings
    .flatMap((finding) => {
      const rowStated = isStated(finding, stated);
      const showModelError = density === 'advanced';
      return rowStated && !showModelError ? [] : [{ findings: [finding], finding, stated: rowStated, showModelError }];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const rightSizingModel: FindingWidgetModel<'rightSizing', RightSizingRow> = {
  type: 'rightSizing',
  rows: rightSizingRows,
  stageOf: () => null,
  summary: (rows) => ({ value: `${rows[0].finding.value} of ${rows[0].finding.observedCores} cores` }),
  listClassName: 'space-y-2 text-sm',
  rowClassName: '',
};
