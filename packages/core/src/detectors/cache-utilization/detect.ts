import { RE_READ_THROUGHPUT_BPS, costOnly, withAssumptions } from '../../impact-model.ts';
import { increaseConf } from '../../remediation.ts';
import type { Finding, ImpactEstimate, FindingOf } from '../../types.ts';
import { loggedAs } from '../conf.ts';
import { cacheSampleConfidence } from '../confidence.ts';
import { defineAppDetector } from '../define.ts';
import { setConfUnlessLogged } from '../fixes.ts';
import type { DetectorApp, DetectorRddInfo } from '../types.ts';
import type { NumericFinding } from '../finding-bases.ts';
import type { AllKeys } from '../../finding-types.ts';
import type { DiscriminatorSlot } from '../../finding-meta.ts';

// The cached RDD a partialCache or diskSpillover finding is about.
interface CachedRddEvidence {
  rddId: number;
  rddName: string;
  memorySize: number;
  diskSize: number;
  numCachedPartitions: number;
  numPartitions: number;
}

export interface CachePartialCacheEvidence extends CachedRddEvidence {
  variant: 'partialCache';
}

export interface CacheDiskSpilloverEvidence extends CachedRddEvidence {
  variant: 'diskSpillover';
}

// The log has no cache-storage evidence at all.
export interface CacheStorageUnobservedEvidence {
  variant: 'storageUnobserved';
  dataUnavailable: true;
}

export type CacheUtilizationEvidence = CachePartialCacheEvidence | CacheDiskSpilloverEvidence | CacheStorageUnobservedEvidence;

export interface CachePartialCacheFinding extends NumericFinding<'cacheUtilization'>, CachePartialCacheEvidence {}

export interface CacheDiskSpilloverFinding extends NumericFinding<'cacheUtilization'>, CacheDiskSpilloverEvidence {}

export interface CacheStorageUnobservedFinding extends NumericFinding<'cacheUtilization'>, CacheStorageUnobservedEvidence {}

export type CacheUtilizationFinding = CachePartialCacheFinding | CacheDiskSpilloverFinding | CacheStorageUnobservedFinding;

// Shared by cacheUtilization's two variants, worded per storage source: neither is a runtime
// block-access read-count.
const CACHE_UTILIZATION_VALIDATION = {
  rddInfo: "This ratio is a point-in-time storage snapshot from stage-submission events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
  blockUpdates: "This ratio is the RDD's peak cache residency rebuilt from block-update events, not a runtime read-count. Confirm against the Spark UI's Storage tab before acting.",
} as const;

/** A sentence names a cached RDD by its first 40 characters, since RDD names are often a whole
 * plan string (the Cache Storage card shows it in full); an unnamed RDD reads "RDD <id>". */
function rddLabel({ id, name }: DetectorRddInfo): string {
  return `RDD ${!name ? id : name.length > 40 ? `${name.slice(0, 40)}...` : name}`;
}

function partialCacheFinding(rdd: DetectorRddInfo, cachedRatio: number, impactBand: 'warning' | 'info'): Finding {
  const cachedPct = Math.round(cachedRatio * 100);
  const evictedPct = 100 - cachedPct;
  return {
    type: 'cacheUtilization', variant: 'partialCache', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'cachedRatio', value: cachedPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${evictedPct}% evicted from cache (${cachedPct}% of partitions cached): increase executor memory or reduce the cached dataset size.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

function diskSpilloverFinding(rdd: DetectorRddInfo, diskRatio: number, impactBand: 'warning' | 'info'): Finding {
  const diskPct = Math.round(diskRatio * 100);
  return {
    type: 'cacheUtilization', variant: 'diskSpillover', stageId: null,
    rddId: rdd.id, rddName: rdd.name || `RDD ${rdd.id}`,
    impactBand, metric: 'diskRatio', value: diskPct,
    confidence: cacheSampleConfidence(rdd.numPartitions),
    validationRequired: CACHE_UTILIZATION_VALIDATION[rdd.storageSource ?? 'rddInfo'],
    memorySize: rdd.memorySize, diskSize: rdd.diskSize,
    numCachedPartitions: rdd.numCachedPartitions, numPartitions: rdd.numPartitions,
    recommendation: `${rddLabel(rdd)} is ${diskPct}% spilled to disk despite requesting MEMORY_AND_DISK: executor memory may be too small for it.`,
    remediation: [increaseConf('spark.executor.memory')],
  };
}

// Persisted RDDs with no storage evidence at all: no block updates in the log, and RDD Info's
// sizes are the 0 that Spark 2.3+ always writes. Reports the gap instead of a clean result, the
// same missing-evidence shape as memoryUtilization's dataUnavailable caveat.
function storageUnobservedFinding(persistedRddCount: number, app: DetectorApp | null): Finding {
  const rdds = persistedRddCount === 1 ? '1 persisted RDD has' : `${persistedRddCount} persisted RDDs have`;
  return {
    type: 'cacheUtilization', variant: 'storageUnobserved', stageId: null,
    impactBand: 'info', metric: 'persistedRdds', value: persistedRddCount, dataUnavailable: true,
    recommendation: `${rdds} no cache-storage evidence in this log, so eviction and disk spillover can't be checked: Spark 2.3+ records cached sizes only as block updates, which need spark.eventLog.logBlockUpdates.enabled=true.`,
    remediation: setConfUnlessLogged(app, 'spark.eventLog.logBlockUpdates.enabled', true),
  };
}

export const cacheUtilizationDetector = defineAppDetector({
  // Per-RDD cache-utilization proxies (this repo's own design: Spark event logs carry no
  // block-access events, so a literal cache hit rate isn't derivable). Two per-RDD tiered
  // checks over rddInfo: partial caching and disk spillover. An RDD can produce both. rddInfo's
  // sizes come from SparkListenerBlockUpdated when the log has it, else from StageSubmitted's
  // RDD Info (0 since Spark 2.3; Spark 1.x fills it only on StageCompleted); with neither, on
  // Spark 2.3+ with logBlockUpdates off, a storageUnobserved caveat replaces them.
  type: 'cacheUtilization', order: 103, bandPolicy: 'own', fixEffort: 'code', version: 2,
  emits: ['cacheUtilization'],
  docAnchor: '#bottleneck-cache-utilization',
  thresholds: {
    cachedRatioWarn: 0.50, cachedRatioInfo: 0.90,
    diskRatioWarn: 0.40, diskRatioInfo: 0.15,
  },
  detect(ctx, thresholds): Finding[] | null {
    const rddInfo = ctx.app?.rddInfo;
    if (!(rddInfo instanceof Map)) return null;
    const out: Finding[] = [];
    let persistedRddCount = 0;
    // With block-update logging on, zero rdd_* updates means nothing was ever cached, not a gap.
    const blockUpdatesLogged = loggedAs(ctx.app, 'spark.eventLog.logBlockUpdates.enabled', true);
    // Spark before 2.3 has no block-update logging and writes RDD Info's cache figures only on
    // StageCompleted, which isn't read: the caveat's advice doesn't apply there. A log with no
    // version is pre-1.3 (no SparkListenerLogStart); every 2.3+ log records one.
    const version = /^(\d+)\.(\d+)/.exec(ctx.app?.sparkVersion ?? '');
    const preBlockUpdates = version == null || Number(version[1]) < 2 || (Number(version[1]) === 2 && Number(version[2]) < 3);
    let anyStorageEvidence = blockUpdatesLogged || preBlockUpdates || (ctx.app?.rddBlockUpdates ?? 0) > 0;
    for (const rdd of rddInfo.values()) {
      const sl = rdd.storageLevel ?? {};
      if (!(sl.useMemory || sl.useDisk)) continue;
      persistedRddCount++;
      if (!((rdd.numCachedPartitions ?? 0) > 0)) continue;
      anyStorageEvidence = true;

      if ((rdd.numPartitions ?? 0) > 0) {
        const cachedRatio = rdd.numCachedPartitions / rdd.numPartitions;
        if (cachedRatio < thresholds.cachedRatioWarn) out.push(partialCacheFinding(rdd, cachedRatio, 'warning'));
        else if (cachedRatio < thresholds.cachedRatioInfo) out.push(partialCacheFinding(rdd, cachedRatio, 'info'));
      }

      if (sl.useMemory && sl.useDisk) {
        const total = (rdd.memorySize ?? 0) + (rdd.diskSize ?? 0);
        if (total > 0) {
          const diskRatio = (rdd.diskSize ?? 0) / total;
          if (diskRatio > thresholds.diskRatioWarn) out.push(diskSpilloverFinding(rdd, diskRatio, 'warning'));
          else if (diskRatio > thresholds.diskRatioInfo) out.push(diskSpilloverFinding(rdd, diskRatio, 'info'));
        }
      }
    }
    if (persistedRddCount > 0 && !anyStorageEvidence) out.push(storageUnobservedFinding(persistedRddCount, ctx.app));
    return out;
  },
  estimate(finding): ImpactEstimate | null {
    // storageUnobserved reports missing evidence: no sizes, so nothing to model.
    if (finding.variant === 'storageUnobserved') return costOnly('none');
    const memorySize = (finding.memorySize as number | undefined) ?? 0;
    const diskSize = (finding.diskSize as number | undefined) ?? 0;
    const numCachedPartitions = (finding.numCachedPartitions as number | undefined) ?? 0;
    const numPartitions = (finding.numPartitions as number | undefined) ?? 0;
    const numUncachedPartitions = Math.max(0, numPartitions - numCachedPartitions);
    const cachedBytes = memorySize + diskSize;
    // Extrapolate never-cached partitions' size from the CACHED partitions' average (uncached/
    // cached, not uncached/total: numCachedPartitions produced cachedBytes). diskSize is added
    // once more: those bytes are cached but on disk, so re-reading them still costs I/O like an uncached partition.
    const uncachedBytes = numCachedPartitions > 0 ? (cachedBytes / numCachedPartitions) * numUncachedPartitions : 0;
    const uncachedOrSpilledBytes = uncachedBytes + diskSize;
    const wasteMs = (uncachedOrSpilledBytes / RE_READ_THROUGHPUT_BPS) * 1000;
    return withAssumptions(
      costOnly('modeled', { value: wasteMs, unit: 'ms' }),
      `assumes ${Math.round(RE_READ_THROUGHPUT_BPS / 1e6)} MB/s per reading task, summed as task time and not divided over executors`,
    );
  },
});

/** What this detector emits per finding type: its finding members and their public evidence. */
export interface Emits {
  cacheUtilization: { finding: CachePartialCacheFinding | CacheDiskSpilloverFinding | CacheStorageUnobservedFinding; evidence: CacheUtilizationEvidence };
}

export const detectors = [cacheUtilizationDetector] as const;

/** The public evidence fields per emitted type, as the evidence report lists them. */
export const evidenceKeys = {
  cacheUtilization: [
    'variant', 'rddId', 'rddName', 'memorySize', 'diskSize', 'numCachedPartitions', 'numPartitions', 'dataUnavailable',
  ],
} as const satisfies {
  cacheUtilization: readonly AllKeys<CacheUtilizationEvidence>[];
};

/** The fields that tell sibling findings apart in their id (see findingId). */
export const idDiscriminators = {
  cacheUtilization: ['variant', 'rddId'],
} as const satisfies {
  cacheUtilization: readonly (DiscriminatorSlot & AllKeys<FindingOf<'cacheUtilization'>>)[];
};
