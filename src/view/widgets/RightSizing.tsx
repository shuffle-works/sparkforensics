import { memo, useMemo, useState } from 'react';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { useStatedAbove } from '@/view/InlineEvidenceContext';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { useAnchoredRow } from '@/view/finding-anchor';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import { formatDuration, IMPACT_BAND_ORDER, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { FindingOf } from '@sparkforensics/core/types.ts';

export type RightSizingProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

function RightSizingRow({ finding }: { finding: FindingOf<'rightSizing'> }) {
  const anchor = useAnchoredRow([finding]);
  const { value, observedCores, observedActiveMs, modeledActiveMs, modelErrorPct } = finding;
  const stated = useStatedAbove(finding);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`transition-colors ${anchor.flashClassName}`}
    >
      {stated ? null : (
        <>
          <p className="flex flex-wrap items-start gap-2">
            <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
            <span>
              <strong>{value} of {observedCores} cores</strong> would be enough
            </span>
          </p>
          <p className="text-xs text-muted-foreground">
            The stages took {formatDuration(observedActiveMs)} on {observedCores} cores. The model predicts{' '}
            {formatDuration(modeledActiveMs)} on {value}.
          </p>
        </>
      )}
      <AdvancedOnly>
        <p className="text-xs text-muted-foreground">Model error at {observedCores} cores: {modelErrorPct}%.</p>
      </AdvancedOnly>
      <ImpactEstimate finding={finding} />
    </div>
  );
}

/** How many cores the run needs, from the what-if scaling model. App-scoped:
 * returns `null` with no `rightSizing` finding. */
export const RightSizing = memo(function RightSizing({ catalog, defaultCollapsed = true }: RightSizingProps) {
  const [page, setPage] = useState(0);

  const findings = useMemo(
    () => findingsOfType(catalog, 'rightSizing').slice().sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]),
    [catalog],
  );
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Right-sized Cluster"
      fixFor={findings}
      impactBand={worstImpactBand(findings)}
      badges={<TagBadge type="rightSizing" impactBand={worstImpactBand(findings) ?? 'info'} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${findings[0].value} of ${findings[0].observedCores} cores`}
          context={findingCount(findings.length)}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {visible.map((f) => (
          <RightSizingRow key={f.id} finding={f} />
        ))}
      </div>
      <RowPagination
        page={effectivePage}
        totalPages={totalPages}
        onPrev={() => setPage((p) => p - 1)}
        onNext={() => setPage((p) => p + 1)}
      />
    </WidgetCard>
  );
});
