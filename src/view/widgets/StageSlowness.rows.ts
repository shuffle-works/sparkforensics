import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface StageSlownessRow extends WidgetRow<'stageSlowness'> {
  finding: FindingOf<'stageSlowness'>;
  /** The line above an evidence panel states the duration and the stage; only the stage's name remains. */
  stated: boolean;
}

export const metricLabel = (finding: FindingOf<'stageSlowness'>): string => `${finding.value}m stage duration`;

export const stageSlownessRows: RowsOf<'stageSlowness', StageSlownessRow> = ({ findings, stated, appModel }) => (
  findings
    .flatMap((finding) => {
      const rowStated = isStated(finding, stated);
      const named = finding.stageId != null && Boolean(appModel.stages.get(finding.stageId)?.name);
      return rowStated && !named ? [] : [{ findings: [finding], finding, stated: rowStated }];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const stageSlownessModel: FindingWidgetModel<'stageSlowness', StageSlownessRow> = {
  type: 'stageSlowness',
  rows: stageSlownessRows,
  stageOf: (row) => row.finding.stageId ?? null,
  summary: (rows) => ({ value: metricLabel(rows[0].finding) }),
  rowElement: 'li',
  listClassName: 'space-y-2',
  rowClassName: 'space-y-1 text-sm',
};
