import { formatBytes, formatDuration, formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { SLOW_HOST_DIMENSION_LABEL } from '@sparkforensics/core/finding-generic-recommendation.ts';
import type { SlowHostFinding } from '@sparkforensics/core/finding-types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface SlowHostRow extends WidgetRow<'slowHost'> {
  finding: SlowHostFinding;
  /** The line above an evidence panel states the impact dot, the stage's pill, the figure and the savings. */
  stated: boolean;
  /** The dot and the stage header; a stated row keeps them only for a named stage. */
  showIdentity: boolean;
  detail: string | null;
  /** The raw measurements behind the figure, which only an evidence panel shows. */
  measurement: string | null;
}

// slowHost reports one of three unrelated sub-signals under the same finding
// type, each with its own unit: a per-host mean-duration ratio, a per-host
// share of the stage's total task time, or a per-executor deviation on a
// secondary dimension (with no `host`). Each needs its own sentence.
export function slowHostDetail(f: SlowHostFinding): string {
  const value = numericValue(f);
  if (f.metric === 'execMaxMedianRatio') {
    return `Executor ${f.executorId}: ${formatMetricValue('ratio', value)} the median ${f.dimension ? SLOW_HOST_DIMENSION_LABEL[f.dimension] : 'value'}`;
  }
  const taskSharePct = Math.round((f.hostTaskShare ?? 0) * 100);
  if (f.metric === 'hostDurationShare') {
    return `${f.host}: ${formatMetricValue('pctFraction', value)} of this stage's task time (${formatMetricValue('pct', taskSharePct)} of tasks)`;
  }
  return `${f.host}: ${formatMetricValue('ratio', value)} median task time (${formatMetricValue('pct', taskSharePct)} of tasks)`;
}

// What the line above an evidence panel leaves out of `slowHostDetail`: its sentence states the
// executor deviation and a host's share of task time, but not a host's task-time ratio or its share of tasks.
function slowHostUnstatedDetail(f: SlowHostFinding): string | null {
  if (f.metric === 'execMaxMedianRatio') return null;
  const taskSharePct = formatMetricValue('pct', Math.round((f.hostTaskShare ?? 0) * 100));
  return f.metric === 'hostDurationShare' ? `${taskSharePct} of tasks ran on ${f.host}` : slowHostDetail(f);
}

// The measurements behind a row, for an evidence panel: the line above states the ratio or share, not the raw magnitude.
function slowHostMeasurement(f: SlowHostFinding): string | null {
  if (f.metric === 'execMaxMedianRatio') {
    if (f.execMaxValue == null || !f.dimension) return null;
    const amount = f.dimension === 'taskTime' ? formatDuration(f.execMaxValue) : formatBytes(f.execMaxValue);
    const of = f.executorCount != null ? `, the most of ${f.executorCount} executors` : '';
    const tasks = f.taskCount != null ? ` (${f.taskCount} tasks in the stage)` : '';
    return `Executor ${f.executorId}: ${amount} of ${SLOW_HOST_DIMENSION_LABEL[f.dimension]}${of}${tasks}.`;
  }
  return f.hostMeanMs != null ? `${f.host}: mean task time ${formatDuration(f.hostMeanMs)}.` : null;
}

export const slowHostRows: RowsOf<'slowHost', SlowHostRow> = ({ findings, stated, appModel, inPanel }) => (
  findings
    .flatMap((finding): SlowHostRow[] => {
      const rowStated = isStated(finding, stated);
      const named = finding.stageId != null && Boolean(appModel.stages.get(finding.stageId)?.name);
      const detail = rowStated ? slowHostUnstatedDetail(finding) : slowHostDetail(finding);
      const measurement = inPanel ? slowHostMeasurement(finding) : null;
      if (rowStated && !named && !detail && !measurement) return [];
      return [{ findings: [finding], finding, stated: rowStated, showIdentity: !rowStated || named, detail, measurement }];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const slowHostModel: FindingWidgetModel<'slowHost', SlowHostRow> = {
  type: 'slowHost',
  rows: slowHostRows,
  stageOf: (row) => row.finding.stageId ?? null,
  summary: (rows) => ({ value: slowHostDetail(rows[0].finding) }),
  rowElement: 'li',
  listClassName: 'space-y-2',
  rowClassName: 'space-y-1 text-sm',
};
