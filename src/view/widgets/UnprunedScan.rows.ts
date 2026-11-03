import { formatBytes, IMPACT_BAND_ORDER, numericValue, recommendationParts } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface UnprunedScanRow extends WidgetRow<'unprunedScan'> {
  finding: FindingOf<'unprunedScan'>;
  /** The line above an evidence panel states the stage pills and the sentence. */
  stated: boolean;
  /** The stage pills; empty when stated. */
  stageIds: readonly number[];
  /** What the scan read and filtered on, shown after the relation. */
  detail: string;
  /** The measured half of the recommendation; null when stated. */
  headline: string | null;
}

export const unprunedScanRows: RowsOf<'unprunedScan', UnprunedScanRow> = ({ findings, stated }) => (
  findings
    .map((finding): UnprunedScanRow => {
      const rowStated = isStated(finding, stated);
      return {
        findings: [finding],
        finding,
        stated: rowStated,
        stageIds: rowStated ? [] : finding.stageIds,
        detail: `read ${formatBytes(numericValue(finding))} from ${finding.partitionsRead} partitions, filtered on ${finding.dataFilters.join(', ')}`,
        headline: rowStated ? null : recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? null,
      };
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const unprunedScanModel: FindingWidgetModel<'unprunedScan', UnprunedScanRow> = {
  type: 'unprunedScan',
  rows: unprunedScanRows,
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
