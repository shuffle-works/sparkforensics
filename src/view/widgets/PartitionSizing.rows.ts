import { formatBytes, IMPACT_BAND_ORDER, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { FindingOf, StageId } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { resolvePlanTree } from '@/view/plan-tree';

export interface PartitionSizingRow extends WidgetRow<'partitionSizing'> {
  stageId: StageId;
  /** The line above an evidence panel states a rule of the stage, and so the stage. */
  stageStated: boolean;
  /** The rules the line above leaves out, each as a short label. */
  rules: readonly { finding: FindingOf<'partitionSizing'>; label: string }[];
  showPlanExplorer: boolean;
}

/** `partitionSizing`'s three rules each report a different metric under one finding type; render
 * `value` as a short label per rule. */
function partitionSizingLabel(finding: FindingOf<'partitionSizing'>): string {
  if (finding.rule === 'lowShuffleParallelism') return `${numericValue(finding)} tasks carrying the shuffle`;
  const bytes = numericValue(finding);
  return finding.rule === 'maxPartitionTooBig' ? `Largest partition ${formatBytes(bytes)} (too large)` : `Largest partition ${formatBytes(bytes)}`;
}

export const partitionSizingRows: RowsOf<'partitionSizing', PartitionSizingRow> = ({ findings, stated, density, appModel }) => {
  const groups = new Map<StageId, FindingOf<'partitionSizing'>[]>();
  for (const finding of findings) {
    if (finding.stageId == null) continue;
    const group = groups.get(finding.stageId);
    if (group) group.push(finding);
    else groups.set(finding.stageId, [finding]);
  }
  return [...groups]
    .map(([stageId, group]) => ({ stageId, group, band: worstImpactBand(group) ?? 'info' }))
    .sort((a, b) => IMPACT_BAND_ORDER[a.band] - IMPACT_BAND_ORDER[b.band] || a.stageId - b.stageId)
    .flatMap(({ stageId, group }): PartitionSizingRow[] => {
      const rules = group.filter((finding) => !isStated(finding, stated)).map((finding) => ({ finding, label: partitionSizingLabel(finding) }));
      const stageStated = rules.length < group.length;
      const showPlanExplorer = density === 'advanced' && resolvePlanTree(stageId, appModel) !== null;
      if (stageStated && !appModel.stages.get(stageId)?.name && rules.length === 0 && !showPlanExplorer) return [];
      return [{ findings: group, stageId, stageStated, rules, showPlanExplorer }];
    });
};

export const partitionSizingModel: FindingWidgetModel<'partitionSizing', PartitionSizingRow> = {
  type: 'partitionSizing',
  rows: partitionSizingRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({ value: `Stage ${rows[0].stageId}` }),
  jumpLabel: (row) => `Stage ${row.stageId}`,
  listClassName: 'space-y-4',
  rowClassName: 'space-y-2',
  separated: true,
};
