import { memo, useMemo, useState } from 'react';

import { sharedDocAnchor } from '@sparkforensics/core/docs-config.ts';
import { IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import { DocsLink } from '@/view/DocsContext';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { useAnchoredRow } from '@/view/finding-anchor';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';
import type { ReactNode } from 'react';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import type { EvidenceAvailabilityEntry, FindingOf } from '@sparkforensics/core/types.ts';

export type ConfigAuditProps = WidgetProps;

/** One flagged config property's row, anchored so a triage route focuses the
 * row itself. `tabIndex={-1}` keeps it programmatically focusable without Tab
 * order. */
function ConfigAuditRow({ finding }: { finding: FindingOf<'configAudit'> }) {
  const anchor = useAnchoredRow([finding]);

  return (
    <li
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-1 transition-colors ${anchor.flashClassName}`}
    >
      <div className="flex items-center gap-2">
        <ImpactDot impactBand={finding.impactBand} />
        <code className="text-xs">{finding.property}</code>
        <span className="text-xs text-muted-foreground">=</span>
        <code className="rounded bg-accent/10 px-1.5 py-0.5 font-mono text-xs text-accent">
          {finding.valueText}
        </code>
      </div>
      <ImpactEstimate finding={finding} />
      <p className="text-sm">
        {finding.recommendation}
        {finding.docAnchor ? (
          <>
            {' '}
            <DocsLink anchor={finding.docAnchor}>Why {finding.property} matters</DocsLink>
          </>
        ) : null}
      </p>
    </li>
  );
}

/**
 * Static Spark-config sanity audit (`auditConfig`), a config-derived finding
 * category separate from the runtime bottleneck `catalog`: config-scope
 * detectors have `inScorecard: false`, so `analyze()` never emits them into
 * `catalog`; only `auditConfig(app)` does. Every offending property is listed
 * with its own impact dot, never just the worst. The `CFG` tag and the
 * `sparkConfiguration` evidence marker each appear once, on the header
 * badge, not per row, the evidence key is a widget-wide constant, not
 * per-finding data.
 */
export const ConfigAudit = memo(function ConfigAudit({ appModel, configFindings, defaultCollapsed = true }: ConfigAuditProps) {
  const [page, setPage] = useState(0);
  // The store's config findings (useIngest in the live app, the payload in an
  // export), threaded from Dashboard; memoized to skip the re-sort on unrelated
  // re-renders.
  // Guard: auditConfig only emits configAudit today; the filter documents that
  // contract so a future type doesn't silently slip through.
  const findings = useMemo(() => findingsOfType(configFindings ?? [], 'configAudit')
    .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]), [configFindings]);

  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  // Called unconditionally, before the empty-findings early return, per rules of
  // hooks (usePagedRows uses useLayoutEffect internally).
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  if (findings.length === 0) {
    const sparkConfiguration = appModel.evidenceAvailability?.entries.find(
      (entry): entry is EvidenceAvailabilityEntry => entry.key === 'sparkConfiguration',
    );

    let message: ReactNode;
    if (sparkConfiguration) {
      if (sparkConfiguration.state === 'present') {
        message = 'No misconfigurations detected.';
      } else if (sparkConfiguration.state === 'unknown' && sparkConfiguration.reasonCode === 'parseIncomplete') {
        message = (
          <>
            <span>{sparkConfiguration.summary} </span>
            <AdvancedOnly>
              <RowStatusCluster evidenceKey="sparkConfiguration" />
            </AdvancedOnly>
          </>
        );
      } else {
        message = (
          <>
            <span>No environment info captured in this log. </span>
            <AdvancedOnly>
              <RowStatusCluster evidenceKey="sparkConfiguration" />
            </AdvancedOnly>
          </>
        );
      }
    } else {
      // Restored snapshot with no evidence-availability ledger: fall back to the
      // config/resources heuristic.
      const evidenceInputs = appModel.app?.evidenceInputs;
      const hasConfig = evidenceInputs
        ? evidenceInputs.environmentUpdates > 0
        : Object.keys(appModel.app?.config ?? {}).length > 0 || !!appModel.app?.resources;
      message = hasConfig
        ? 'No misconfigurations detected.'
        : (
          <>
            <span>No environment info captured in this log. </span>
            <AdvancedOnly>
              <RowStatusCluster evidenceKey="sparkConfiguration" />
            </AdvancedOnly>
          </>
        );
    }

    const body = <p className="text-muted-foreground text-xs">{message}</p>;
    return (
      <WidgetCard title="Config Sanity" compact summary={body}>
        {body}
      </WidgetCard>
    );
  }

  const impactBand = worstImpactBand(findings);

  return (
    <WidgetCard
      title="Config Sanity"
      impactBand={impactBand}
      badges={<TagBadge type="configAudit" impactBand={impactBand ?? 'info'} docAnchor={sharedDocAnchor(findings)} />}
      statusBadge={
        <AdvancedOnly>
          <RowStatusCluster evidenceKey="sparkConfiguration" />
        </AdvancedOnly>
      }
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${findings.length}`}
          context={`misconfiguration${findings.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <ul className="space-y-4">
        {visible.map((f) => (
          <ConfigAuditRow key={f.id} finding={f} />
        ))}
      </ul>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
