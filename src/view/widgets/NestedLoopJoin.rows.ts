import { IMPACT_BAND_ORDER, recommendationParts } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface NestedLoopJoinRow extends WidgetRow<'nestedLoopJoin'> {
  finding: FindingOf<'nestedLoopJoin'>;
  /** The line above an evidence panel states the stage pills, the sentence and the savings. */
  stated: boolean;
  /** The stage pills; empty when stated. */
  stageIds: readonly number[];
  /** The measured half of the recommendation; null when stated. */
  headline: string | null;
  /** The join behind the row: the sentence above a panel states the output rows, not the join itself. Null unless stated. */
  detail: string | null;
}

function joinMeasurement(finding: FindingOf<'nestedLoopJoin'>): string {
  const { nodeName, joinType, condition, leftRows, rightRows } = finding;
  const join = `${nodeName}${joinType ? ` (${joinType})` : ''}, ${condition ? `condition ${condition}` : 'no join condition'}.`;
  return leftRows != null && rightRows != null
    ? `${join} Input rows: ${leftRows.toLocaleString('en-US')} left, ${rightRows.toLocaleString('en-US')} right.`
    : join;
}

export const nestedLoopJoinRows: RowsOf<'nestedLoopJoin', NestedLoopJoinRow> = ({ findings, stated }) => (
  findings
    .map((finding): NestedLoopJoinRow => {
      const rowStated = isStated(finding, stated);
      return {
        findings: [finding],
        finding,
        stated: rowStated,
        stageIds: rowStated ? [] : finding.stageIds,
        headline: rowStated ? null : recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? null,
        detail: rowStated ? joinMeasurement(finding) : null,
      };
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const nestedLoopJoinModel: FindingWidgetModel<'nestedLoopJoin', NestedLoopJoinRow> = {
  type: 'nestedLoopJoin',
  rows: nestedLoopJoinRows,
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
