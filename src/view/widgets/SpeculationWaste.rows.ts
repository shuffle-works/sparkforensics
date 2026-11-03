import { formatDuration, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface SpeculationWasteRow extends WidgetRow<'speculationWaste'> {
  finding: FindingOf<'speculationWaste'>;
  /** The line above an evidence panel states the wasted time; only the stage's name and `note` remain. */
  stated: boolean;
  /** How many tasks ran speculatively; null unless stated and the stage has tasks. */
  note: string | null;
}

export const metricLabel = (finding: FindingOf<'speculationWaste'>): string => formatDuration(numericValue(finding));

export const speculationWasteRows: RowsOf<'speculationWaste', SpeculationWasteRow> = ({ findings, stated, appModel }) => (
  findings
    .flatMap((finding) => {
      const rowStated = isStated(finding, stated);
      const stage = finding.stageId != null ? appModel.stages.get(finding.stageId) : undefined;
      const note = rowStated && stage?.taskCount
        ? `${String(stage.speculativeTasks ?? 0)} of ${stage.taskCount} tasks ran speculatively; ${String(stage.speculationWastedAttempts ?? 0)} attempts were discarded.`
        : null;
      if (rowStated && note === null && !stage?.name) return [];
      return [{ findings: [finding], finding, stated: rowStated, note }];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const speculationWasteModel: FindingWidgetModel<'speculationWaste', SpeculationWasteRow> = {
  type: 'speculationWaste',
  rows: speculationWasteRows,
  stageOf: (row) => row.finding.stageId ?? null,
  summary: (rows) => ({ value: metricLabel(rows[0].finding) }),
  rowElement: 'li',
  listClassName: 'space-y-2',
  rowClassName: 'space-y-1 text-sm',
};
