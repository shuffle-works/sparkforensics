import { memo, useMemo, useState } from 'react';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { pathBasename, formatBytes, formatMetricValue, IMPACT_BAND_ORDER, numericValue, worstImpactBand } from '@sparkforensics/core/format-utils.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { AdvancedOnly } from '@/view/AdvancedOnly';
import { DocsLink } from '@/view/DocsContext';
import { useAnchoredRow } from '@/view/finding-anchor';
import { ImpactEstimate } from '../ImpactEstimate.tsx';
import { ImpactDot, TagBadge } from '@/view/ImpactBadge';
import { RowPagination } from '@/view/RowPagination';
import { useActiveRouteTarget } from '@/view/TriageNavigationContext';
import { usePagedRows } from '@/view/usePagedRows';
import { WidgetCard } from '@/view/WidgetCard';
import { WidgetLeadSummary } from '@/view/WidgetLeadSummary';
import type { WidgetProps } from '@/view/detector-registry';

// App-wide RDD cache/persist surfacing, backed by the `cacheUtilization`
// detector for per-RDD partial-cache / disk-spillover impact band. Per-executor
// block attribution is deferred: the parser folds block updates into per-RDD
// totals only.

interface StorageLevel {
  useMemory?: boolean;
  useDisk?: boolean;
  deserialized?: boolean;
  replication?: number;
}

interface RddInfoRow {
  id: number;
  name?: string;
  storageLevel?: StorageLevel;
  numPartitions?: number;
  numCachedPartitions?: number;
  memorySize?: number;
  diskSize?: number;
}

// `appModel.app` carries a runtime `rddInfo` Map not on the frozen
// `SparkAppInfo` type; bridged with a single cast.
interface AppWithRddInfo {
  rddInfo?: Map<number, RddInfoRow>;
}

// The `cacheUtilization` detector emits three variants from one `type`, none
// declared on the frozen `Finding` interface; bridged with a single cast.
interface CacheUtilizationFinding extends Finding {
  variant?: 'partialCache' | 'diskSpillover' | 'storageUnobserved';
  dataUnavailable?: boolean;
  rddId?: number;
  rddName?: string;
  memorySize?: number;
  diskSize?: number;
  numCachedPartitions?: number;
  numPartitions?: number;
}

const MAX_SHORT_NAME_LENGTH = 70;

function storageLevelLabel(sl?: StorageLevel): string {
  if (!sl) return '—';
  const parts: string[] = [];
  if (sl.useMemory) parts.push('Memory');
  if (sl.useDisk) parts.push('Disk');
  if (sl.deserialized) parts.push('Deserialized');
  else if (sl.useMemory || sl.useDisk) parts.push('Serialized');
  if ((sl.replication ?? 1) > 1) parts.push(`x${sl.replication}`);
  return parts.join(' · ') || '—';
}

function rowName(r: RddInfoRow): string {
  return r.name || `RDD ${r.id}`;
}

function rowShortName(r: RddInfoRow): string {
  const short = pathBasename(rowName(r));
  return short.length <= MAX_SHORT_NAME_LENGTH ? short : `${short.slice(0, MAX_SHORT_NAME_LENGTH)}…`;
}

/** Surface each `cacheUtilization` variant's ratio, memory/disk sizes and
 * partition counts up front rather than in the expanded recommendation prose. */
function cacheFindingDetail(f: CacheUtilizationFinding): string {
  if (f.variant === 'storageUnobserved') {
    return 'No block updates logged: cached partition counts and sizes are unknown';
  }
  const pct = formatMetricValue('pct', numericValue(f));
  if (f.variant === 'diskSpillover') {
    return `${pct} spilled to disk: ${formatBytes(f.diskSize ?? 0)} disk / ${formatBytes(f.memorySize ?? 0)} memory`;
  }
  return `${pct} cached (${f.numCachedPartitions ?? 0}/${f.numPartitions ?? 0} partitions)`;
}

/** One flagged RDD finding's row, anchored so a triage route focuses the row
 * itself. `tabIndex={-1}` keeps it programmatically focusable without Tab order.
 * The recommendation is always visible. */
function CacheFindingRow({ finding }: { finding: CacheUtilizationFinding }) {
  const anchor = useAnchoredRow([finding]);
  const label = finding.dataUnavailable ? 'Cache storage not logged' : finding.rddName ?? `RDD ${finding.rddId}`;

  return (
    <div
      ref={anchor.ref}
      tabIndex={anchor.tabIndex}
      data-flashed={anchor.dataFlashed}
      className={`space-y-1 transition-colors ${anchor.flashClassName}`}
    >
      <p className="flex flex-wrap items-start gap-2">
        <ImpactDot impactBand={finding.impactBand} className="mt-1.5" />
        <span>{label}</span>
      </p>
      <AdvancedOnly>
        <p className="text-xs text-muted-foreground">{cacheFindingDetail(finding)}</p>
      </AdvancedOnly>
      <ImpactEstimate finding={finding} />
      <p className="text-sm">{finding.recommendation}</p>
    </div>
  );
}

export type CacheUtilizationProps = Pick<WidgetProps, 'appModel' | 'catalog'>;

export const CacheUtilization = memo(function CacheUtilization({ appModel, catalog }: CacheUtilizationProps) {
  const [tablePage, setTablePage] = useState(0);
  const [findingsPage, setFindingsPage] = useState(0);
  const rddInfo = (appModel.app as unknown as AppWithRddInfo | null)?.rddInfo;

  // Cached-RDD rows depend only on `rddInfo`; memoized to skip recompute on
  // unrelated re-renders.
  const rows = useMemo(() => rddInfo
    ? [...rddInfo.values()]
        .filter((r) => (r.storageLevel?.useMemory || r.storageLevel?.useDisk) && (r.numCachedPartitions ?? 0) > 0)
        .sort((a, b) => (b.memorySize ?? 0) + (b.diskSize ?? 0) - ((a.memorySize ?? 0) + (a.diskSize ?? 0)))
    : [], [rddInfo]);

  // Depends only on `catalog`; separate memo from `rows` above.
  const allFindings = useMemo(() => (catalog.filter((f) => f.type === 'cacheUtilization') as CacheUtilizationFinding[]).sort(
    (a, b) => IMPACT_BAND_ORDER[a.impactBand] - IMPACT_BAND_ORDER[b.impactBand],
  ), [catalog]);

  // Called unconditionally, before the empty-`rows` early return, per rules
  // of hooks (usePagedRows uses useLayoutEffect internally).
  const table = usePagedRows(rows, tablePage, setTablePage);
  const activeRouteTarget = useActiveRouteTarget();
  const findingsRouteIndex = activeRouteTarget ? allFindings.findIndex((f) => f === activeRouteTarget.finding) : null;
  const findingsPaged = usePagedRows(allFindings, findingsPage, setFindingsPage, findingsRouteIndex);

  // Persisted RDDs with no storage evidence still mount the card, so the run
  // reads as "not checked" instead of a clean Cache Storage result.
  const unobserved = allFindings.find((f) => f.dataUnavailable);
  if (rows.length === 0 && !unobserved) return null;

  const findingsForRdd = (rddId: number) => allFindings.filter((f) => f.rddId === rddId);
  const totalBytes = rows.reduce((sum, r) => sum + (r.memorySize ?? 0) + (r.diskSize ?? 0), 0);

  return (
    <div data-widget="cache-utilization">
      <WidgetCard
        title="Cache Storage"
        impactBand={worstImpactBand(allFindings)}
        badges={
          <>
            {allFindings.length > 0 ? (
              <TagBadge type="cacheUtilization" impactBand={worstImpactBand(allFindings) ?? 'info'} />
            ) : null}
            <span className="text-xs text-muted-foreground">
              {rows.length > 0 ? `${rows.length} cached RDD${rows.length === 1 ? '' : 's'}` : 'cache storage not logged'}, see{' '}
              <DocsLink anchor="#memory-model">how Spark accounts cached memory</DocsLink>
            </span>
          </>
        }
        defaultCollapsed
        summary={rows.length > 0
          ? <WidgetLeadSummary value={formatBytes(totalBytes)} context="cached across memory + disk" />
          : <WidgetLeadSummary value="Unknown" context={`${numericValue(unobserved!)} persisted, no block updates`} />}
      >
        {rows.length > 0 ? (
          <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>RDD</TableHead>
                <TableHead>Storage level</TableHead>
                <TableHead className="text-right">Cached partitions</TableHead>
                <TableHead className="text-right">Memory</TableHead>
                <TableHead className="text-right">Disk</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {table.visible.map((r) => {
                const name = rowName(r);
                const shortName = rowShortName(r);
                const rowFindings = findingsForRdd(r.id);
                return (
                  <TableRow key={r.id}>
                    <TableCell className="max-w-80 truncate" title={name !== shortName ? name : undefined}>
                      {shortName}
                      {rowFindings.length > 0 && (
                        <ImpactDot impactBand={worstImpactBand(rowFindings) ?? 'info'} className="ml-1.5" />
                      )}
                    </TableCell>
                    <TableCell>{storageLevelLabel(r.storageLevel)}</TableCell>
                    <TableCell className="text-right">
                      {r.numCachedPartitions} / {r.numPartitions}
                    </TableCell>
                    <TableCell className="text-right">{formatBytes(r.memorySize ?? 0)}</TableCell>
                    <TableCell className="text-right">{formatBytes(r.diskSize ?? 0)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <RowPagination
            page={table.effectivePage}
            totalPages={table.totalPages}
            onPrev={() => setTablePage((p) => p - 1)}
            onNext={() => setTablePage((p) => p + 1)}
          />
          </>
        ) : null}
        {allFindings.length > 0 ? (
          <div className="mt-3 space-y-2 text-sm">
            {findingsPaged.visible.map((f) => (
              <CacheFindingRow key={f.id} finding={f} />
            ))}
            <RowPagination
              page={findingsPaged.effectivePage}
              totalPages={findingsPaged.totalPages}
              onPrev={() => setFindingsPage((p) => p - 1)}
              onNext={() => setFindingsPage((p) => p + 1)}
            />
          </div>
        ) : null}
      </WidgetCard>
    </div>
  );
});
