import { describeSpillRatio, formatBytes, formatRowWidth, IMPACT_BAND_ORDER, numericValue, partitionHint } from '@sparkforensics/core/format-utils.ts';
import type { SpillExchange } from '@sparkforensics/core/finding-types.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { resolvePlanTree } from '@/view/plan-tree';

export type SpillClass = 'skew' | 'volume' | 'unclassified';

export interface SpillRow extends WidgetRow<'spill'> {
  finding: FindingOf<'spill'>;
  stageId: number;
  /** The line above an evidence panel states the stage pill, the memory spilled, the operators' spill and the ratio. */
  stated: boolean;
  spillClass: SpillClass;
  /** Bytes the stage spilled to disk. */
  diskBytes: number;
  /** Where the stage's spill sits: operators, ratio, widths, partitioning and the SQL description. */
  evidence: readonly string[];
  /** The partition count to try; null unless the spill is volume-driven and the input partitioning is not the job's own. */
  partitionHint: { recommended: number; current: number } | null;
  showPlanExplorer: boolean;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
}

// `hashpartitioning(k#1, 200), 200 partitions, REPARTITION_BY_NUM`, as far as the plan gave it.
function formatExchangeArguments({ partitioning, partitions, origin }: SpillExchange): string {
  return [partitioning, partitions !== undefined ? `${partitions} partitions` : undefined, origin].filter(Boolean).join(', ');
}

function evidenceLines(finding: FindingOf<'spill'>, stated: boolean): string[] {
  const { operators = [], exchanges = [], spillToInputRatio, wideRows = false, reads, sqlDescription } = finding;
  const widths = exchanges.map(formatRowWidth).filter(Boolean);
  const partitioned = exchanges.filter((ex) => ex.partitioning);
  return [
    ...(!stated && operators.length > 0
      ? [`Spilled by ${operators.map((op) => `${op.name}${op.feeds ? ` (feeds ${op.feeds})` : ''} ${formatBytes(op.spillBytes)}`).join(', ')}`]
      : []),
    ...(!stated && spillToInputRatio !== undefined
      ? [describeSpillRatio(spillToInputRatio, wideRows, reads === 'input', exchanges[0]?.columns)]
      : []),
    ...operators.filter((op) => op.arguments).map((op) => (
      `${op.name} ${op.nodeId}${op.global === undefined ? '' : op.global ? ' (global sort)' : ' (sort within partitions)'}: ${op.arguments}`
    )),
    ...(widths.length > 0 ? [`Rows read: ${widths.join('; ')}`] : []),
    ...(partitioned.length > 0 ? [`Exchange: ${partitioned.map(formatExchangeArguments).join('; ')}`] : []),
    ...(sqlDescription ? [`SQL: ${sqlDescription}`] : []),
  ];
}

export const spillRows: RowsOf<'spill', SpillRow> = ({ findings, stated, density, appModel }) => (
  findings
    .flatMap((finding): SpillRow[] => {
      if (finding.stageId == null) return [];
      const { stageId } = finding;
      const rowStated = isStated(finding, stated);
      const stage = appModel.stages.get(stageId);
      const spillClass = stage?.spillClassification ?? 'unclassified';
      return [{
        findings: [finding],
        finding,
        stageId,
        stated: rowStated,
        spillClass,
        diskBytes: stage?.diskBytesSpilled ?? 0,
        evidence: evidenceLines(finding, rowStated),
        partitionHint: spillClass === 'volume' && stage ? partitionHint(finding, stage) : null,
        showPlanExplorer: density === 'advanced' && resolvePlanTree(stageId, appModel) !== null,
        showStatus: density === 'advanced',
      }];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand]
      || numericValue(b.finding) - numericValue(a.finding))
);

export const spillModel: FindingWidgetModel<'spill', SpillRow> = {
  type: 'spill',
  rows: spillRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({
    value: formatBytes(numericValue(rows[0].finding)),
    context: `peak · ${rows.length} stage${rows.length === 1 ? '' : 's'}`,
  }),
  listClassName: 'space-y-4',
  rowClassName: 'space-y-2',
  separated: true,
};
