import { sharedDocAnchor } from '@sparkforensics/core/docs-config.ts';
import { recommendationParts } from '@sparkforensics/core/finding-names.ts';
import { IMPACT_BAND_ORDER } from '@sparkforensics/core/format-utils.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

export interface ConfigAuditRow extends WidgetRow<'configAudit'> {
  finding: FindingOf<'configAudit'>;
  /** The audited property and its value: the line above an evidence panel shows the sentence, so with a
   * docs link the link is the evidence, and without one the setting is. */
  showSetting: boolean;
  /** The measured half of the recommendation, which the line above states; null when stated. */
  measured: string | null;
  /** The recommendation paragraph: the docs link, with the measured sentence before it when not stated. */
  showParagraph: boolean;
  /** The line above an evidence panel states the savings. */
  stated: boolean;
}

// configFindings is the `auditConfig(app)` result, a stream separate from the run's catalog.
export const configAuditRows: RowsOf<'configAudit', ConfigAuditRow> = ({ findings, stated }) => (
  findings
    .map((finding): ConfigAuditRow => {
      const rowStated = isStated(finding, stated);
      return {
        findings: [finding],
        finding,
        showSetting: !(rowStated && finding.docAnchor),
        measured: rowStated ? null : recommendationParts(finding.recommendation ?? '').measured ?? finding.recommendation ?? '',
        showParagraph: !(rowStated && !finding.docAnchor),
        stated: rowStated,
      };
    })
    .sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand])
);

export const configAuditModel: FindingWidgetModel<'configAudit', ConfigAuditRow> = {
  type: 'configAudit',
  rows: configAuditRows,
  stageOf: () => null,
  findings: ({ configFindings }) => findingsOfType(configFindings ?? [], 'configAudit'),
  summary: (rows) => ({ value: `${rows.length}`, context: `misconfiguration${rows.length === 1 ? '' : 's'} flagged` }),
  // Each audited property stamps its own docAnchor, so the badge links only when they all agree.
  tagDocAnchor: (rows) => sharedDocAnchor(rows.map((row) => row.finding)),
  rowElement: 'li',
  listClassName: 'space-y-4',
  rowClassName: 'space-y-1',
};
