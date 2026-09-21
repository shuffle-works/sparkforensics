import { memo, useMemo, useState } from 'react';

import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { useAnchoredRow } from '@/view/finding-anchor';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { formatMetricValue, IMPACT_BAND_ORDER, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';

export type ExecutorUtilizationProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

/** One flagged finding's row, anchored so a triage route focuses the row
 * itself. `tabIndex={-1}` keeps it programmatically focusable without Tab order. */
function UtilizationRow({ finding }: { finding: Finding }) {
  const anchor = useAnchoredRow([finding]);

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`transition-colors ${anchor.flashClassName}`}
    >
      <p className="flex flex-wrap items-start gap-2">
        <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
        <strong>{formatMetricValue('pct', numericValue(finding))}</strong> average executor utilization
      </p>
      <ImpactEstimate finding={finding} />
      <p>{finding.recommendation}</p>
    </div>
  );
}

/** Average executor CPU utilization across the run. `utilization` is a
 * `reference`-region type excluded from always-mounted status (see
 * `ALWAYS_MOUNTED_EXCEPTIONS` in `detector-registry.tsx`): like an ordinary
 * action widget, it returns `null` with no findings and collapses to a
 * `CleanCheckRow` instead. Split out of the former combined
 * `MemoryUtilization.tsx`; see `MemoryUtilization.tsx` for its
 * `memoryUtilization`-only sibling. */
export const ExecutorUtilization = memo(function ExecutorUtilization({ catalog, defaultCollapsed = true }: ExecutorUtilizationProps) {
  const [page, setPage] = useState(0);

  const findings = useMemo(
    () =>
      catalog
        .filter((f) => f.type === 'utilization')
        .slice()
        .sort((a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand]),
    [catalog],
  );
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  return (
    <WidgetCard
      title="Executor Utilization"
      impactBand={worstImpactBand(findings)}
      badges={<TagBadge type="utilization" impactBand={worstImpactBand(findings) ?? 'info'} />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${formatMetricValue('pct', numericValue(findings[0]))} average`}
          context={`${findings.length} item${findings.length === 1 ? '' : 's'} flagged`}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {visible.map((f) => (
          <UtilizationRow key={f.id} finding={f} />
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
