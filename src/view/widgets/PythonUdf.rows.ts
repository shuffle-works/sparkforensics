import { IMPACT_BAND_ORDER, recommendationParts } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface PythonUdfRow extends WidgetRow<'pythonUdf'> {
  finding: FindingOf<'pythonUdf'>;
  /** The sentence the row shows. */
  headline: string;
}

// The line above an evidence panel states the stage pills, the sentence and the savings, so a stated
// finding has nothing left to show.
export const pythonUdfRows: RowsOf<'pythonUdf', PythonUdfRow> = ({ findings, stated }) => (
  findings
    .filter((finding) => !isStated(finding, stated))
    .map((finding): PythonUdfRow => ({
      findings: [finding],
      finding,
      headline: recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? '',
    }))
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const pythonUdfModel: FindingWidgetModel<'pythonUdf', PythonUdfRow> = {
  type: 'pythonUdf',
  rows: pythonUdfRows,
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
