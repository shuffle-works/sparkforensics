import { IMPACT_BAND_ORDER, recommendationParts, stageIdOf } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

export interface JoinKeyCastRow extends WidgetRow<'joinKeyCast'> {
  finding: FindingOf<'joinKeyCast'>;
  /** The line above an evidence panel states the stage pills, the sentence and the savings. */
  stated: boolean;
  /** The stage pills; empty when stated. */
  stageIds: readonly number[];
  /** The measured half of the recommendation; null when stated. */
  headline: string | null;
  /** The keys behind the row: the sentence above a panel states the advice, not the keys. Null unless stated. */
  detail: string | null;
}

function keyMeasurement(finding: FindingOf<'joinKeyCast'>): string {
  return `${finding.nodeName} on ${finding.castKeys.join(' and ')}; the next exchange shuffles by ${finding.exchangeKeys.join(', ')}.`;
}

export const joinKeyCastRows: RowsOf<'joinKeyCast', JoinKeyCastRow> = ({ findings, stated }) => (
  findings
    .map((finding): JoinKeyCastRow => {
      const rowStated = isStated(finding, stated);
      return {
        findings: [finding],
        finding,
        stated: rowStated,
        stageIds: rowStated ? [] : finding.stageIds,
        headline: rowStated ? null : recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? null,
        detail: rowStated ? keyMeasurement(finding) : null,
      };
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const joinKeyCastModel: FindingWidgetModel<'joinKeyCast', JoinKeyCastRow> = {
  type: 'joinKeyCast',
  rows: joinKeyCastRows,
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
