import { DocsLink } from '@/view/DocsContext';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot } from '@/view/ImpactBadge';
import { configAuditModel, type ConfigAuditRow } from './ConfigAudit.rows';

/** One flagged config property's row. */
function Row({ row: { finding, showSetting, measured, showParagraph, stated } }: FindingRowProps<ConfigAuditRow>) {
  return (
    <>
      {showSetting ? (
        <div className="flex items-center gap-2">
          <ImpactDot impactBand={finding.impactBand} />
          <code className="text-xs">{finding.property}</code>
          <span className="text-xs text-muted-foreground">=</span>
          <code className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">
            {finding.valueText}
          </code>
        </div>
      ) : null}
      {stated ? null : <ImpactEstimate finding={finding} />}
      {showParagraph ? (
        <p className="text-sm">
          {measured}
          {finding.docAnchor ? (
            <>
              {measured === null ? null : ' '}
              <DocsLink anchor={finding.docAnchor}>Why {finding.property} matters</DocsLink>
            </>
          ) : null}
        </p>
      ) : null}
    </>
  );
}

// The `CFG` tag and the `sparkConfiguration` evidence marker each appear once, on the header, not per
// row: the evidence key is a widget-wide constant, not per-finding data.
const Status: NonNullable<FindingWidgetView<ConfigAuditRow>['Status']> = ({ density }) => (
  density === 'advanced' ? <RowStatusCluster evidenceKey="sparkConfiguration" /> : null
);

/**
 * Static Spark-config sanity audit (`auditConfig`), a config-derived finding category separate from
 * the runtime bottleneck `catalog`: config-scope detectors have `inScorecard: false`, so `analyze()`
 * never emits them into `catalog`; only `auditConfig(app)` does. Every offending property is listed
 * with its own impact dot, never just the worst.
 */
export const ConfigAudit = defineFindingWidget(configAuditModel, { Row, Status });
