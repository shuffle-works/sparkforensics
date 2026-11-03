import type { FindingOf } from '@sparkforensics/core/types';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface CachingRow extends WidgetRow<'cachingOpportunity'> {
  finding: FindingOf<'cachingOpportunity'>;
  /** The line above an evidence panel states the savings. */
  stated: boolean;
  /** The confidence marker belongs to the Advanced density. */
  showStatus: boolean;
}

// The relation read most comes first, then the one read by the most queries.
export const cachingRows: RowsOf<'cachingOpportunity', CachingRow> = ({ findings, stated, density }) => (
  findings
    .map((finding): CachingRow => ({ findings: [finding], finding, stated: isStated(finding, stated), showStatus: density === 'advanced' }))
    .sort((a, b) => b.finding.totalReadBytes - a.finding.totalReadBytes || (b.finding.value ?? 0) - (a.finding.value ?? 0))
);

export const cachingOpportunityModel: FindingWidgetModel<'cachingOpportunity', CachingRow> = {
  type: 'cachingOpportunity',
  rows: cachingRows,
  title: 'Caching Opportunities',
  stageOf: () => null,
  summary: ([{ finding: top }]) => ({ value: `${top.value}×`, context: `read by ${top.value} queries: ${top.relation}` }),
  rowElement: 'tr',
  // The classes of the table's own row, which a row element placed by the shell does not get.
  rowClassName: 'border-b hover:bg-muted/50 has-aria-expanded:bg-muted/50',
  listClassName: '[&_tr:last-child]:border-0',
};
