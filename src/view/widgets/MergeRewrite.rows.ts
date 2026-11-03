import { IMPACT_BAND_ORDER } from '@sparkforensics/core/view-model';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';
import { PLAN_TAG_CLASS } from '@/view/plan-finding-shared';

type MergeFinding = FindingOf<'mergeRewrite'>;

// MERGE commands whose counters are identical share one row. A MERGE that trips both rules has two
// findings with the same counters, so `executionIds` counts each command once.
interface MergeRowGroup {
  findings: MergeFinding[];
  executionIds: number[];
  targets: (string | null)[];
}

export interface MergeRewriteRow extends WidgetRow<'mergeRewrite'> {
  /** The first finding of the group: its counters and impact estimate stand for the row. */
  finding: MergeFinding;
  /** The line above an evidence panel states a finding of the group; it shows the stage pills. */
  stated: boolean;
  /** The stages of every finding in the group, ascending; empty when stated. */
  stageIds: readonly number[];
  /** The MERGE commands the row stands for, by query number and target. */
  label: string;
  /** The rows rewritten and the files and partitions kept. */
  measurement: string;
}

function groupByCounters(findings: readonly MergeFinding[]): MergeRowGroup[] {
  const groups = new Map<string, MergeRowGroup>();
  for (const f of findings) {
    const key = JSON.stringify([f.rewrittenRows, f.changedRows, f.filesBefore, f.filesAfter, f.partitionsScanned, f.partitionsTouched]);
    const group = groups.get(key) ?? { findings: [], executionIds: [], targets: [] };
    group.findings.push(f);
    if (!group.executionIds.includes(f.executionId)) {
      group.executionIds.push(f.executionId);
      group.targets.push(f.target);
    }
    groups.set(key, group);
  }
  return [...groups.values()];
}

function listQueries(ids: number[]): string {
  const sorted = [...ids].sort((a, b) => a - b).map(String);
  return sorted.length < 2 ? sorted.join('') : `${sorted.slice(0, -1).join(', ')} and ${sorted[sorted.length - 1]}`;
}

// Names the MERGE by its SQL query number, and by its target when the log names one for all of them.
function rowLabel({ executionIds, targets }: MergeRowGroup): string {
  const target = targets.every((t) => t === targets[0]) ? targets[0] : null;
  const on = target ? ` on ${target}` : '';
  return executionIds.length === 1
    ? `MERGE query ${executionIds[0]}${on}`
    : `${executionIds.length} MERGE commands (queries ${listQueries(executionIds)})${on}`;
}

function mergeMeasurement(finding: MergeFinding): string {
  const n = (v: number) => v.toLocaleString('en-US');
  const { rewrittenRows, changedRows, filesBefore, filesAfter, partitionsScanned, partitionsTouched } = finding;
  const rows = `${n(rewrittenRows)} unmodified rows rewritten, ${n(changedRows)} rows inserted, updated or deleted.`;
  return filesBefore != null && filesAfter != null
    ? `${rows} Target files: ${n(filesBefore)} before skipping, ${n(filesAfter)} after.${partitionsScanned != null && partitionsTouched != null
      ? ` Partitions: ${n(partitionsScanned)} scanned, ${n(partitionsTouched)} changed.` : ''}`
    : rows;
}

export const mergeRewriteRows: RowsOf<'mergeRewrite', MergeRewriteRow> = ({ findings, stated }) => (
  groupByCounters([...findings].sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]))
    .map((group): MergeRewriteRow => {
      const rowStated = group.findings.some((finding) => isStated(finding, stated));
      return {
        findings: group.findings,
        finding: group.findings[0],
        stated: rowStated,
        stageIds: rowStated ? [] : [...new Set(group.findings.flatMap((f) => f.stageIds))].sort((a, b) => a - b),
        label: rowLabel(group),
        measurement: mergeMeasurement(group.findings[0]),
      };
    })
);

export const mergeRewriteModel: FindingWidgetModel<'mergeRewrite', MergeRewriteRow> = {
  type: 'mergeRewrite',
  rows: mergeRewriteRows,
  stageOf: (row) => (row.finding.stageIds.length > 0 ? Math.min(...row.finding.stageIds) : null),
  summary: (rows) => {
    const commandCount = new Set(rows.flatMap((row) => row.findings.map((finding) => finding.executionId))).size;
    return { value: `${commandCount} MERGE command${commandCount === 1 ? '' : 's'}` };
  },
  tagClassName: PLAN_TAG_CLASS,
  rowElement: 'li',
  listClassName: 'space-y-3 text-sm',
  rowClassName: 'space-y-2',
  separated: true,
};
