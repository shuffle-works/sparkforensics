import { formatMetricValue, numericValue } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { stageGroupRows, stageGroupSummary, type StageGroupRow } from './StageGroup.rows';

export type StageShapeRow = StageGroupRow<'stageShape'>;

// `stageShape`'s `rule` field names the shape smell it detected; turn it into a short human label.
const STAGE_SHAPE_RULE_LABEL: Record<FindingOf<'stageShape'>['rule'], string> = {
  lowParallelism: 'Low parallelism',
  dataExplosion: 'Data explosion',
  taskStageSkew: 'Task/stage skew',
};

function findingLabel(finding: FindingOf<'stageShape'>): string {
  const label = STAGE_SHAPE_RULE_LABEL[finding.rule];
  if (finding.rule === 'lowParallelism') return `${label}: ${finding.value} tasks per core`;
  // taskStageSkew's value is the longest task's share of the stage's wall-clock, a 0-1 fraction.
  return finding.rule === 'taskStageSkew' ? `${label}: ${formatMetricValue('pctFraction', numericValue(finding))}` : `${label}: ${finding.value}`;
}

export const stageShapeRows = stageGroupRows<'stageShape'>({ findingLabel, idPrefix: 'stage-shape' });

export const stageShapeModel: FindingWidgetModel<'stageShape', StageShapeRow> = {
  type: 'stageShape',
  rows: stageShapeRows,
  stageOf: (row) => row.stageId,
  summary: stageGroupSummary,
  rowClassName: 'space-y-2',
  separated: true,
};
