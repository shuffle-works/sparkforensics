import type { ReactNode } from 'react';
import { GitMerge } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Table, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { formatBytes } from '@sparkforensics/core/view-model';
import { defineFindingWidget, type FindingRowProps, type FindingWidgetView } from '@/view/finding-widget';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { RowStatusCluster } from '@/view/RowStatusCluster';
import { cachingOpportunityModel, type CachingRow } from './CachingOpportunity.rows';

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

/** One flagged relation's row. */
function Row({ row: { finding, stated, showStatus } }: FindingRowProps<CachingRow>) {
  const isComposite = finding.variant === 'composite';

  return (
    <>
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
      <TableCell className="text-right">{formatBytes(finding.totalReadBytes)}</TableCell>
      <TableCell>
        {stated ? null : <ImpactEstimate finding={finding} />}
        {showStatus ? <RowStatusCluster confidence={finding.confidence} validationRequired={finding.validationRequired} /> : null}
      </TableCell>
    </>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Relation</TableHead>
          <TableHead>Read by</TableHead>
          <TableHead className="text-right">Data read</TableHead>
          <TableHead>Estimate</TableHead>
        </TableRow>
      </TableHeader>
      {children}
    </Table>
  );
}

const Lead: NonNullable<FindingWidgetView<CachingRow>['Lead']> = ({ density }) => (
  density === 'advanced' ? (
    <p className="mb-3 text-xs text-muted-foreground">
      Reuse is inferred from plan structure, not confirmed by execution. Verify before caching.
    </p>
  ) : null
);

/** App-scope card for the cross-execution relation-reuse detector: one row per input relation scanned
 * by two or more SQL executions, sorted by bytes read (then reuse count) so the highest-impact re-read
 * sits first. */
export const CachingOpportunity = defineFindingWidget(cachingOpportunityModel, { Row, Lead, Frame });
