import { formatMetricValue, numericValue } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { stageGroupRows, stageGroupSummary, type StageGroupRow } from './StageGroup.rows';

export type SkewRow = StageGroupRow<'skew'>;

function findingLabel(finding: FindingOf<'skew'>): string {
  const { dataRatio } = finding;
  return `${finding.metric}: ${formatMetricValue('ratio', numericValue(finding))}${dataRatio != null ? `, data ${formatMetricValue('ratio', dataRatio)}` : ''}`;
}

export const skewRows = stageGroupRows<'skew'>({ findingLabel, idPrefix: 'skew' });

export const skewModel: FindingWidgetModel<'skew', SkewRow> = {
  type: 'skew',
  rows: skewRows,
  stageOf: (row) => row.stageId,
  summary: stageGroupSummary,
  rowClassName: 'space-y-2',
  separated: true,
};
