import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface UnderBroadcastRow extends WidgetRow<'underBroadcast'> {
  finding: FindingOf<'underBroadcast'>;
  /** The sentence the row shows. */
  headline: string;
}

// The line above an evidence panel states the stage pills, the sentence and the savings, so a stated
// finding has nothing left to show.
export const underBroadcastRows: RowsOf<'underBroadcast', UnderBroadcastRow> = ({ findings, stated }) => (
  findings
    .filter((finding) => !isStated(finding, stated))
    .map((finding): UnderBroadcastRow => ({
      findings: [finding],
      finding,
      headline: recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? '',
    }))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const underBroadcastModel: FindingWidgetModel<'underBroadcast', UnderBroadcastRow> = {
  type: 'underBroadcast',
  rows: underBroadcastRows,
  stageOf: (row) => (row.finding.stageIds.length > 0 ? Math.min(...row.finding.stageIds) : null),
  summary: (rows) => {
    const stageCount = new Set(rows.flatMap((row) => row.finding.stageIds)).size;
    return { value: `${stageCount} stage${stageCount === 1 ? '' : 's'}` };
  },
  tagClassName: PLAN_TAG_CLASS,
  rowElement: 'li',
  listClassName: 'space-y-3 text-sm',
  rowClassName: 'space-y-2',
  separated: true,
};
