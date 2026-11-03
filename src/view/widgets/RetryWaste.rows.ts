import { formatDuration, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface RetryWasteRow extends WidgetRow<'retryWaste'> {
  finding: FindingOf<'retryWaste'>;
  stageId: number;
  /** The line above an evidence panel states the stage and the wasted time. */
  stated: boolean;
  /** The Advanced sentence that extends the detail line; null at Basic or when the finding has none. */
  extension: string | null;
}

// `extended`'s first sentence restates the duration the detail line shows; strip that clause so the
// Advanced sentence extends the line instead of repeating it.
function advancedExtension(finding: FindingOf<'retryWaste'>): string {
  return (finding.extended ?? '').replace(/, wasting \d+s of executor time\./, '.');
}

export const retryWasteRows: RowsOf<'retryWaste', RetryWasteRow> = ({ findings, stated, density }) => (
  findings
    .flatMap((finding) => {
      if (finding.stageId == null) return [];
      const rowStated = isStated(finding, stated);
      const extension = density === 'advanced' && finding.extended ? advancedExtension(finding) : null;
      if (rowStated && extension === null) return [];
      return [{ findings: [finding], finding, stageId: finding.stageId, stated: rowStated, extension }];
    })
    .sort(
      (a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand]
        || (typeof b.finding.value === 'number' ? b.finding.value : 0) - (typeof a.finding.value === 'number' ? a.finding.value : 0),
    )
);

export const retryWasteModel: FindingWidgetModel<'retryWaste', RetryWasteRow> = {
  type: 'retryWaste',
  rows: retryWasteRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({ value: formatDuration(numericValue(rows[0].finding)) }),
  rowElement: 'li',
  rowClassName: 'flex flex-col gap-1',
};
