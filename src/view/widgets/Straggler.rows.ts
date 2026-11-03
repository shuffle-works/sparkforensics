import { formatMetricValue, IMPACT_BAND_ORDER, numericValue, stragglerCauseSummary } from '@sparkforensics/core/view-model';
import type { StragglerFinding } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface StragglerRow extends WidgetRow<'straggler'> {
  finding: StragglerFinding;
  /** The line above an evidence panel states the stage, the straggler figure, its cause and the savings. */
  stated: boolean;
  /** The dot and the stage header; a stated row keeps them only for a named stage. */
  showIdentity: boolean;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
  /** Null when stated. */
  detail: string | null;
  causeSummary: string | null;
  /** How many tasks ran over 4x the stage's median; an evidence panel shows it. */
  stragglerCount: number;
  /** An evidence panel adds the stage's task duration spread. */
  showSpread: boolean;
}

// straggler reports whichever signal drove the finding: a speculative-retry
// count, a straggler-task percentage, or skew's duration ratio, distinguished by its `unit` field.
export function stragglerDetail(f: StragglerFinding): string {
  const value = numericValue(f);
  if (f.unit === 'ratio') return `task duration ${f.metric} ${value}×`;
  return f.unit === 'count'
    ? `${value} speculative attempt${value === 1 ? '' : 's'} discarded`
    : `${formatMetricValue('pct', value)} of tasks straggled`;
}

export const stragglerRows: RowsOf<'straggler', StragglerRow> = ({ findings, stated, density, appModel, inPanel = false }) => (
  findings
    .flatMap((finding): StragglerRow[] => {
      const rowStated = isStated(finding, stated);
      const named = finding.stageId != null && Boolean(appModel.stages.get(finding.stageId)?.name);
      const advanced = density === 'advanced';
      const row: StragglerRow = {
        findings: [finding],
        finding,
        stated: rowStated,
        showIdentity: !rowStated || named,
        showStatus: advanced,
        detail: rowStated ? null : stragglerDetail(finding),
        causeSummary: rowStated ? null : stragglerCauseSummary(finding),
        stragglerCount: inPanel ? finding.stragglerCount : 0,
        showSpread: inPanel && finding.stageId != null,
      };
      const hasStatus = advanced && Boolean(finding.confidence) && finding.confidence !== 'high';
      return !rowStated || row.showIdentity || hasStatus || row.stragglerCount > 0 || row.showSpread ? [row] : [];
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const stragglerModel: FindingWidgetModel<'straggler', StragglerRow> = {
  type: 'straggler',
  rows: stragglerRows,
  title: 'Stragglers',
  stageOf: (row) => row.finding.stageId ?? null,
  summary: (rows) => ({ value: stragglerDetail(rows[0].finding) }),
  rowElement: 'li',
  listClassName: 'space-y-2',
  rowClassName: 'space-y-1 text-sm',
};
