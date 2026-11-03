import { formatBytes, formatMetricValue, IMPACT_BAND_ORDER, numericValue } from '@sparkforensics/core/format-utils.ts';
import { isCaveat } from '@sparkforensics/core/recommendation-rollup.ts';
import type { AppModel, FindingOf } from '@sparkforensics/core/types.ts';
import { isStated, type RowsOf, type WidgetRow } from '@/view/evidence-panel';
import type { FindingWidgetModel } from '@/view/finding-widget';

// App-wide RDD cache/persist surfacing, backed by the `cacheUtilization` detector for per-RDD
// partial-cache / disk-spillover impact band. Per-executor block attribution is deferred: the parser
// folds block updates into per-RDD totals only.

export interface StorageLevel {
  useMemory?: boolean;
  useDisk?: boolean;
  deserialized?: boolean;
  replication?: number;
}

export interface RddInfoRow {
  id: number;
  name?: string;
  storageLevel?: StorageLevel;
  numPartitions?: number;
  numCachedPartitions?: number;
  memorySize?: number;
  diskSize?: number;
}

export const rddInfoOf = (appModel: AppModel): Map<number, RddInfoRow> | undefined => appModel.app?.rddInfo;

/** The RDDs with cached partitions in memory or on disk, largest first. */
export const cachedRdds = (rddInfo: Map<number, RddInfoRow> | undefined): RddInfoRow[] => rddInfo
  ? [...rddInfo.values()]
      .filter((r) => (r.storageLevel?.useMemory || r.storageLevel?.useDisk) && (r.numCachedPartitions ?? 0) > 0)
      .sort((a, b) => (b.memorySize ?? 0) + (b.diskSize ?? 0) - ((a.memorySize ?? 0) + (a.diskSize ?? 0)))
  : [];

export interface CacheRow extends WidgetRow<'cacheUtilization'> {
  finding: FindingOf<'cacheUtilization'>;
  /** A finding that says the log has no cache-storage evidence; it has no shared fix, so its row keeps its own text. */
  caveat: boolean;
  /** The line above an evidence panel states the finding's savings. */
  stated: boolean;
  label: string;
  /** The measured ratio, sizes and partition counts, or a caveat's own text. */
  detail: string;
}

/** Surface each `cacheUtilization` variant's ratio, memory/disk sizes and partition counts up front
 * rather than in the expanded recommendation prose. */
function cacheFindingDetail(f: FindingOf<'cacheUtilization'>): string {
  if (f.variant === 'storageUnobserved') {
    return 'No block updates logged: cached partition counts and sizes are unknown';
  }
  const pct = formatMetricValue('pct', numericValue(f));
  if (f.variant === 'diskSpillover') {
    return `${pct} spilled to disk: ${formatBytes(f.diskSize ?? 0)} disk / ${formatBytes(f.memorySize ?? 0)} memory`;
  }
  return `${pct} cached (${f.numCachedPartitions ?? 0}/${f.numPartitions ?? 0} partitions)`;
}

// The card needs the table of cached RDDs, or persisted RDDs with no storage evidence (which read as
// "not checked" instead of a clean Cache Utilization result).
export const cacheRows: RowsOf<'cacheUtilization', CacheRow> = ({ findings, stated, appModel }) => {
  const rows = findings.flatMap((finding): CacheRow[] => {
    const caveat = isCaveat(finding);
    const detail = caveat ? finding.recommendation : cacheFindingDetail(finding);
    if (!detail) return [];
    return [{
      findings: [finding],
      finding,
      caveat,
      stated: isStated(finding, stated),
      label: finding.variant === 'storageUnobserved' ? 'Cache storage not logged' : finding.rddName ?? `RDD ${finding.rddId}`,
      detail,
    }];
  });
  if (cachedRdds(rddInfoOf(appModel)).length === 0 && !rows.some((row) => row.caveat)) return [];
  return rows.sort((a, b) => IMPACT_BAND_ORDER[a.finding.impactBand] - IMPACT_BAND_ORDER[b.finding.impactBand]);
};

export const cacheUtilizationModel: FindingWidgetModel<'cacheUtilization', CacheRow> = {
  type: 'cacheUtilization',
  rows: cacheRows,
  stageOf: () => null,
  listClassName: 'mt-3 space-y-2 text-sm',
  rowClassName: 'space-y-1',
};
