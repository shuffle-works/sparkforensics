
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { pathBasename, formatBytes, worstImpactBand } from '@sparkforensics/core/view-model';
import type { Finding } from '@sparkforensics/core/types';
import { ImpactDot } from '@/view/ImpactBadge';
import { RowPagination } from '@/view/RowPagination';
import { usePagedRows } from '@/view/usePagedRows';
import { useCardStateKey, useWidgetState } from '@/view/useWidgetState';
import type { RddInfoRow, StorageLevel } from './CacheUtilization.rows';

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

/** The cached RDDs a page at a time, each marked with the worst band of the findings on it. */
export function CachedRddTable({ rdds, findings }: { rdds: readonly RddInfoRow[]; findings: readonly (Finding & { rddId?: number })[] }) {
  const [page, setPage] = useWidgetState(useCardStateKey('page'), 0);
  const { totalPages, effectivePage, visible } = usePagedRows([...rdds], page, setPage);
  return (
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
      {visible.map((r) => {
        const name = rowName(r);
        const shortName = rowShortName(r);
        const rowFindings = findings.filter((f) => f.rddId === r.id);
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
    page={effectivePage}
    totalPages={totalPages}
    onPrev={() => setPage((p) => p - 1)}
    onNext={() => setPage((p) => p + 1)}
  />
    </>
  );
}
