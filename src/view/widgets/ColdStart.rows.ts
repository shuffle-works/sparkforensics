import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface ColdStartRow extends WidgetRow<'coldStart'> {
  finding: FindingOf<'coldStart'>;
}

// The row shows the measured wait; the card states the fix once.
export const metricLabel = (finding: FindingOf<'coldStart'>): string => `${finding.value}s`;

// The line above an evidence panel states the wait and its savings, so a stated finding has no row.
export const coldStartRows: RowsOf<'coldStart', ColdStartRow> = ({ findings, stated }) => (
  findings
    .filter((finding) => !isStated(finding, stated))
    .map((finding) => ({ findings: [finding], finding }))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const coldStartModel: FindingWidgetModel<'coldStart', ColdStartRow> = {
  type: 'coldStart',
  rows: coldStartRows,
  stageOf: (row) => row.finding.stageId ?? null,
  summary: (rows) => ({ value: metricLabel(rows[0].finding) }),
  rowElement: 'li',
  listClassName: 'space-y-2',
  rowClassName: 'space-y-1 text-sm',
};
