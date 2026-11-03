import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface GcRow extends WidgetRow<'gc'> {
  finding: FindingOf<'gc'>;
  stageId: number;
  /** The line above an evidence panel states the GC share and the stage. */
  stated: boolean;
  /** The section the row sits in: garbage collection eating an outsized share of run time, or little of it (memory may be over-provisioned). */
  branch: 'high' | 'low';
  /** The stage's name and the status marker are what a stated row keeps of its header. */
  showHeader: boolean;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
  runTime: number;
}

// gc's value is always a numeric percentage.
const gcValue = (finding: FindingOf<'gc'>): number => (typeof finding.value === 'number' ? finding.value : 0);

export const gcRows: RowsOf<'gc', GcRow> = ({ findings, stated, density, appModel }) => {
  const rows = findings.flatMap((finding): GcRow[] => {
    if (finding.stageId == null) return [];
    const rowStated = isStated(finding, stated);
    const stage = appModel.stages.get(finding.stageId);
    const advanced = density === 'advanced';
    return [{
      findings: [finding],
      finding,
      stageId: finding.stageId,
      stated: rowStated,
      branch: finding.direction === 'low' ? 'low' : 'high',
      showHeader: !rowStated || Boolean(stage?.name) || (advanced && Boolean(finding.confidence) && finding.confidence !== 'high'),
      showStatus: advanced,
      runTime: stage?.executorRunTime ?? 0,
    }];
  });
  // The high-GC rows lead, each branch by its GC share.
  return rows.sort((a, b) => Number(a.branch === 'low') - Number(b.branch === 'low') || gcValue(b.finding) - gcValue(a.finding));
};

export const gcModel: FindingWidgetModel<'gc', GcRow> = {
  type: 'gc',
  rows: gcRows,
  stageOf: (row) => row.stageId,
  summary: (rows) => ({ value: `${rows.reduce((worst, row) => (gcValue(row.finding) > gcValue(worst) ? row.finding : worst), rows[0].finding).value}%` }),
  sections: {
    key: (row) => row.branch,
    title: (branch, rows) => `${branch === 'low' ? 'Low GC (cost)' : 'GC overhead'} · ${rows.length} stage${rows.length === 1 ? '' : 's'}`,
  },
  rowElement: 'li',
  listClassName: 'space-y-3',
  rowClassName: 'space-y-2',
  separated: true,
};
