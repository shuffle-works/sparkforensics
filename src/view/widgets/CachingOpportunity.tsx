import { memo, useMemo, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatBytes } from '@sparkforensics/core/format-utils.ts';
import { GitMerge } from 'lucide-react';
import { useAnchoredRow } from '@/view/finding-anchor';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { RowPagination } from '@/view/RowPagination';
import { TagBadge } from '@/view/ImpactBadge';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import type { WidgetProps } from '@/view/detector-registry';
import type { Finding } from '@sparkforensics/core/types.ts';

/** Renders a composite's leaf relation names with the join/union connector word
 * emphasized between them. Real space characters are kept around the connector
 * so the combined text still equals the original flat `relation` string. */
function CompositeRelationNames({ relations, operator }: { relations: { relation: string }[]; operator?: 'join' | 'union' }) {
  const connectorWord = operator === 'union' ? 'union' : 'join';
  return (
    <span className="inline-flex flex-wrap items-baseline">
      {relations.map((r, idx) => (
        <span key={r.relation}>
          {idx > 0 ? (
            <>
              {' '}
              <span className="mx-1 font-semibold uppercase text-xs tracking-wide text-primary">{connectorWord}</span>
              {' '}
            </>
          ) : null}
          {r.relation}
        </span>
      ))}
    </span>
  );
}

/** One flagged relation's row, anchored so a triage route focuses the row
 * itself. `tabIndex={-1}` keeps it programmatically focusable without Tab order. */
function CachingRow({ finding }: { finding: Finding }) {
  const anchor = useAnchoredRow([finding]);
  const isComposite = finding.variant === 'composite';

  return (
    <TableRow
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`transition-colors ${anchor.flashClassName}`}
    >
      <TableCell>
        <span className="inline-flex items-center gap-2">
          {isComposite ? <GitMerge className="size-3.5 text-muted-foreground" aria-hidden="true" /> : null}
          {isComposite && finding.relations && finding.relations.length > 0 ? (
            <CompositeRelationNames relations={finding.relations} operator={finding.operator} />
          ) : (
            <span>{finding.relation}</span>
          )}
          {isComposite ? (
            <Badge variant="outline" className="text-xs uppercase border-dashed">
              {finding.operator?.toUpperCase()}
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-xs uppercase">
              {finding.format}
            </Badge>
          )}
        </span>
      </TableCell>
      <TableCell>{finding.value} queries</TableCell>
      <TableCell className="text-right">{formatBytes(finding.totalReadBytes ?? 0)}</TableCell>
      <TableCell>
        <ImpactEstimate finding={finding} />
        <p className="mt-1">{finding.recommendation}</p>
      </TableCell>
    </TableRow>
  );
}

/** App-scope card for the cross-execution relation-reuse detector: one row per
 * input relation scanned by two or more SQL executions, sorted by bytes read
 * (then reuse count) so the highest-impact re-read sits first. Renders nothing
 * when clean. */
export const CachingOpportunity = memo(function CachingOpportunity({ catalog, defaultCollapsed = true }: WidgetProps) {
  const [page, setPage] = useState(0);
  // Depends only on `catalog`; memoized to skip recompute on unrelated re-renders.
  const findings = useMemo(() => catalog
    .filter((f) => f.type === 'cachingOpportunity')
    // `value` is always a numeric execution count, but `Finding.value` is typed
    // `number | string`, so narrow defensively rather than assume.
    .sort((a, b) => (b.totalReadBytes ?? 0) - (a.totalReadBytes ?? 0)
      || (typeof b.value === 'number' ? b.value : 0) - (typeof a.value === 'number' ? a.value : 0)), [catalog]);

  const activeRouteTarget = useActiveRouteTarget();
  const routeIndex = activeRouteTarget ? findings.findIndex((f) => f === activeRouteTarget.finding) : null;
  // Called unconditionally, before the empty-findings early return, per rules of
  // hooks (usePagedRows uses useLayoutEffect internally).
  const { totalPages, effectivePage, visible } = usePagedRows(findings, page, setPage, routeIndex);

  if (findings.length === 0) return null;

  const top = findings[0];

  return (
    <WidgetCard
      title="Caching Opportunities"
      impactBand="info"
      badges={<TagBadge type="cachingOpportunity" impactBand="info" />}
      defaultCollapsed={defaultCollapsed}
      summary={
        <WidgetLeadSummary
          value={`${top.value}×`}
          context={`read by ${top.value} queries: ${top.relation}`}
        />
      }
    >
      <div className="space-y-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Relation</TableHead>
              <TableHead>Read by</TableHead>
              <TableHead className="text-right">Data read</TableHead>
              <TableHead>Recommendation</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((f, i) => (
              <CachingRow key={`${f.format}:${f.relation}:${(f.executionIds ?? []).join(',')}:${i}`} finding={f} />
            ))}
          </TableBody>
        </Table>
        <AdvancedOnly>
          {/* Confidence is a per-detector constant here (every emitted finding is
              'low'), so it's a single caveat below the table instead of a marker
              repeated on every row. */}
          <RowStatusCluster confidence="low" />
          <p className="text-xs text-muted-foreground">
            Reuse is inferred from plan structure, not confirmed by execution. Verify before caching.
          </p>
        </AdvancedOnly>
        <RowPagination
          page={effectivePage}
          totalPages={totalPages}
          onPrev={() => setPage((p) => p - 1)}
          onNext={() => setPage((p) => p + 1)}
        />
      </div>
    </WidgetCard>
  );
});
