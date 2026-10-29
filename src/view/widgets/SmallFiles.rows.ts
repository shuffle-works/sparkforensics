import { formatBytes, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { stageIdOf } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface SmallFilesRow extends WidgetRow<'smallFiles'> {
  finding: FindingOf<'smallFiles'>;
  /** The line above an evidence panel states the stage pills, the sentence and the savings. */
  stated: boolean;
  /** The stage pills; empty when stated. */
  stageIds: readonly number[];
  /** The measured half of the recommendation; null when stated. */
  headline: string | null;
  /** The average file size and the total; null unless stated. */
  detail: string | null;
}

function totalDetail(finding: FindingOf<'smallFiles'>): string {
  const averageBytes = numericValue(finding);
  return `Average file size ${formatBytes(averageBytes)}, about ${formatBytes(averageBytes * finding.fileCount)} ${finding.direction === 'write' ? 'written' : 'read'} in total.`;
}

export const smallFilesRows: RowsOf<'smallFiles', SmallFilesRow> = ({ findings, stated }) => (
  findings
    .map((finding): SmallFilesRow => {
      const rowStated = isStated(finding, stated);
      return {
        findings: [finding],
        finding,
        stated: rowStated,
        stageIds: rowStated ? [] : finding.stageIds,
        headline: rowStated ? null : recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? null,
        detail: rowStated ? totalDetail(finding) : null,
      };
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const smallFilesModel: FindingWidgetModel<'smallFiles', SmallFilesRow> = {
  type: 'smallFiles',
  rows: smallFilesRows,
  stageOf: (row) => stageIdOf(row.finding),
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
