import { memo, useMemo, useState } from 'react';

import { AdvancedOnly } from '@/view/AdvancedOnly';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { useAnchoredRow } from '@/view/finding-anchor';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { findingCount, WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { formatMetricValue, formatRawWaste, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { findingsOfType } from '@sparkforensics/core/findings-of-type.ts';
import { isRealFinding } from '@sparkforensics/core/recommendation-rollup.ts';
import type { WidgetProps } from '@/view/detector-registry';
import type { MemoryUtilizationFinding } from '@sparkforensics/core/finding-types.ts';
import { usePresentedTone, useWorstPresentedTone } from '@/view/impact-presentation';

export type MemoryUtilizationProps = Pick<WidgetProps, 'catalog' | 'defaultCollapsed'>;

/** Each `memoryUtilization` variant reports a different metric under `value`:
 * idle core-time rate, highest-executor heap ratio (with a `rule` sub-discriminator
 * for direction), or the app-wide MB-seconds waste model. Keep it always
 * visible, not buried in the expanded recommendation. */
function memoryDetail(f: MemoryUtilizationFinding): string {
  const value = numericValue(f);
  const pct = formatMetricValue('pct', value);
  if (f.variant === 'idleCores') return `${pct} of available core-time idle`;
  if (f.variant === 'memoryBand') {
    return `${pct} of allocated heap used: over-provisioned`;
  }
  // Same units as the step's savings figure, so the two never disagree in form.
  return `~${formatRawWaste({ value, unit: 'mbSeconds' })} wasted`;
}

// Only the `rule`-discriminated variant (heapOverProvisioned)
// have a diagnosis clause worth keeping as deeper Advanced-tier context: it's
// the same figure memoryDetail() already shows, in the detector's own words.
// idleCores/wasteModel have no such restatement to gate.
function memoryDiagnosis(f: MemoryUtilizationFinding): string | null {
  if (f.rule == null) return null;
  const recommendation = f.recommendation ?? '';
  const adviceStart = recommendation.indexOf(': ');
  return adviceStart === -1 ? null : ` ${recommendation.slice(0, adviceStart)}.`;
}

/** Per-executor findings name the executor; the two app-wide variants (idle-core
 * rate, waste model) get a fixed label. */
function rowLabel(f: MemoryUtilizationFinding): string {
  if ('executorId' in f && f.executorId != null) return `Executor ${f.executorId}`;
  return f.variant === 'idleCores' ? 'Idle cores' : 'Memory waste';
}

/** One flagged finding's row, anchored so a triage route focuses the row
 * itself. `tabIndex={-1}` keeps it programmatically focusable without Tab
 * order. The confidence/evidence marker lives on the widget header (see
 * `statusBadge` below), not per row: `executorMetrics` evidence is a
 * widget-wide constant, so repeating it on every row would just be noise. */
function MemoryRow({ finding }: { finding: MemoryUtilizationFinding }) {
  const anchor = useAnchoredRow([finding]);
  const tone = usePresentedTone(finding);

  if (finding.dataUnavailable) {
    return (
      <div
        ref={anchor.ref}
        tabIndex={anchor.tabIndex}
        data-flashed={anchor.dataFlashed}
        className={`space-y-1 transition-colors ${anchor.flashClassName}`}
      >
        <AdvancedOnly>
          <p className="text-muted-foreground">{finding.recommendation}</p>
        </AdvancedOnly>
      </div>
    );
  }

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`transition-colors ${anchor.flashClassName}`}
    >
      <p className="flex flex-wrap items-start gap-2">
        <ImpactDot impactBand={tone} className="mt-1.5" />
        <strong>{rowLabel(finding)}</strong>
      </p>
      <p className="text-xs text-muted-foreground">
        {memoryDetail(finding)}
        {memoryDiagnosis(finding) != null ? <AdvancedOnly>{memoryDiagnosis(finding)}</AdvancedOnly> : null}
      </p>
      <ImpactEstimate finding={finding} />
    </div>
  );
}

/** Executor memory utilization. Lists every affected sub-finding: idle cores,
 * per-executor heap bands, and the memory-waste model, never just the worst.
 * `utilization` is now `ExecutorUtilization.tsx`'s own type. `memoryUtilization`
 * is a `reference`-region type excluded from always-mounted status (see
 * `ALWAYS_MOUNTED_EXCEPTIONS` in `detector-registry.tsx`): like an ordinary
 * action widget, it returns `null` with no findings and collapses to a
 * `CleanCheckRow` instead. */
export const MemoryUtilization = memo(function MemoryUtilization({ catalog, defaultCollapsed = true }: MemoryUtilizationProps) {
  const [page, setPage] = useState(0);

  const { findings, groupConfidence } = useMemo(() => {
    const findings = findingsOfType(catalog, 'memoryUtilization').sort(
      (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
    );
    // Only claim a single header-level confidence when every real finding
    // actually shares it; a mixed group would otherwise show one finding's
    // confidence as if it applied to all of them. dataUnavailable caveats
    // carry no confidence of their own, so they're excluded from the check.
    const realFindings = findings.filter(isRealFinding);
    const groupConfidence = realFindings.every((f) => f.confidence === realFindings[0]?.confidence) ? realFindings[0] : undefined;
    return { findings, groupConfidence };
  }, [catalog]);
  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  const worstTone = useWorstPresentedTone(findings);

  // A dataUnavailable-only caveat isn't real evidence of an issue (see
  // `isRealFinding`'s own doc comment): treat it the same as no findings at all.
  if (!findings.some(isRealFinding)) return null;

  const worst = findings.find((f) => !f.dataUnavailable) ?? findings[0];

  return (
    <WidgetCard
      title="Memory Utilization"
      fixFor={findings}
      impactBand={worstTone}
      badges={<TagBadge type="memoryUtilization" impactBand={worstTone ?? 'info'} />}
      statusBadge={
        // `executorMetrics` is a widget-wide evidence constant, so it sits on
        // the header once, not per row.
        <AdvancedOnly>
          <RowStatusCluster
            confidence={groupConfidence?.confidence}
            validationRequired={groupConfidence?.validationRequired}
            evidenceKey="executorMetrics"
          />
        </AdvancedOnly>
      }
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={rowLabel(worst)}
          context={findingCount(findings.length)}
        />
      }
    >
      <div className="space-y-2 text-sm">
        {visible.map((f) => (
          <MemoryRow key={f.id} finding={f} />
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
