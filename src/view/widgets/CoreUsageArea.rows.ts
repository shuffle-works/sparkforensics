import type { LocalityChart } from '@sparkforensics/core/analysis';
import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface CoreUsageRow extends WidgetRow<'coreLocality'> {
  finding: FindingOf<'coreLocality'>;
  /** The line above the widget states the non-local share and the generic fix. */
  stated: boolean;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
}

// Fewer points than this show no trend, so an evidence panel leaves the chart out.
const MIN_PANEL_CHART_POINTS = 3;

/** Whether an evidence panel embeds the chart: the run has activity and enough points for a trend. */
export const chartShowsTrend = (chart: LocalityChart): boolean => chart.hasActivity && chart.points.length >= MIN_PANEL_CHART_POINTS;

export const coreUsageRows: RowsOf<'coreLocality', CoreUsageRow> = ({ findings, stated, density }) => (
  findings.map((finding) => ({
    findings: [finding],
    finding,
    stated: isStated(finding, stated),
    showStatus: density === 'advanced',
  }))
);

// An always-mounted reference tile: the chart is the content, and the finding adds its row when the
// run has one.
export const coreUsageModel: FindingWidgetModel<'coreLocality', CoreUsageRow> = {
  type: 'coreLocality',
  rows: coreUsageRows,
  stageOf: () => null,
  alwaysMounted: true,
  listClassName: 'space-y-2',
  rowClassName: 'space-y-2',
};
