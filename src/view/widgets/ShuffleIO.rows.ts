import { formatBytes, IMPACT_BAND_ORDER, numericValue, partitionHint } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { resolvePlanTree } from '@/view/plan-tree';

export interface ShuffleRow extends WidgetRow<'shuffle'> {
  finding: FindingOf<'shuffle'>;
  stageId: number;
  /** The line above an evidence panel states the stage pill, the shuffle read and the savings. */
  stated: boolean;
  /** Peak shuffle read of the stage. */
  peak: number;
  /** The shuffle read (null when stated) and write; null when stated and nothing was written. */
  usage: { readBytes: number | null; writeBytes: number } | null;
  /** The spread of the stage's shuffle reads across its tasks; null unless stated. */
  detail: string | null;
  partitionHint: { recommended: number; current: number } | null;
  showPlanExplorer: boolean;
}

export const shuffleRows: RowsOf<'shuffle', ShuffleRow> = ({ findings, stated, density, appModel }) => (
  findings
    .flatMap((finding): ShuffleRow[] => {
      if (finding.stageId == null) return [];
      const { stageId } = finding;
      const rowStated = isStated(finding, stated);
      const stage = appModel.stages.get(stageId);
      const writeBytes = stage?.shuffleWriteBytes ?? 0;
      const row: ShuffleRow = {
        findings: [finding],
        finding,
        stageId,
        stated: rowStated,
        peak: numericValue(finding),
        usage: rowStated && writeBytes === 0 ? null : { readBytes: rowStated ? null : numericValue(finding), writeBytes },
        detail: rowStated && stage?.taskCount
          ? `${stage.taskCount} tasks read a median of ${formatBytes(stage.shuffleReadP50)} each, the largest ${formatBytes(stage.shuffleReadMax)}.`
          : null,
        partitionHint: stage ? partitionHint(finding, stage) : null,
        showPlanExplorer: density === 'advanced' && resolvePlanTree(stageId, appModel) !== null,
      };
      const hasContent = !rowStated || Boolean(stage?.name) || row.usage || row.detail || row.partitionHint || row.showPlanExplorer;
      return hasContent ? [row] : [];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand] || b.peak - a.peak)
);

export const shuffleModel: FindingWidgetModel<'shuffle', ShuffleRow> = {
  type: 'shuffle',
  rows: shuffleRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({
    value: formatBytes(rows[0].peak),
    context: `Peak shuffle read · ${rows.length} finding${rows.length === 1 ? '' : 's'}`,
  }),
  jumpLabel: (row) => `Stage ${row.stageId} (${formatBytes(row.peak)})`,
  listClassName: 'space-y-4',
  rowClassName: 'space-y-2',
  separated: true,
};
