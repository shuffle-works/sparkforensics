import type { FindingOf } from '@sparkforensics/core/types.ts';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { stageGroupRows, stageGroupSummary, type StageGroupRow } from './StageGroup.rows';

export type TinyTaskRow = StageGroupRow<'tinyTask'>;

// `tinyTask` findings always carry the same single metric (`taskDurationP50`), so one label format fits.
const findingLabel = (finding: FindingOf<'tinyTask'>): string => `P50 ${finding.value}ms across many small tasks`;

export const tinyTaskRows = stageGroupRows<'tinyTask'>({ findingLabel, idPrefix: 'tiny-task', statesP50: true });

export const tinyTaskModel: FindingWidgetModel<'tinyTask', TinyTaskRow> = {
  type: 'tinyTask',
  rows: tinyTaskRows,
  stageOf: (row) => row.stageId,
  summary: stageGroupSummary,
  rowClassName: 'space-y-2',
  separated: true,
};
