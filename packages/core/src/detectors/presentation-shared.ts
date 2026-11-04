// Helpers the presentation rows share. HTML-export safe: no import of detector code.
import type { AqeSkewCase, Remediation, SkewOrigin } from '../finding-types.ts';

/** A share threshold as captions and caveats state it: 0.005 -> "0.5%", never float noise like 7.000000000000001%. */
export const shareLabel = (share: number): string => `${Math.round(share * 1e6) / 1e4}%`;

/** `n.toLocaleString('en-US')` for a whole number, without loading ICU (about 10 ms the first time it is
 * used), which keeps the CLI's startup off that cost. Other values take the locale path. */
export function groupThousands(n: number): string {
  return Number.isSafeInteger(n) ? String(n).replace(/\B(?=(\d{3})+$)/g, ',') : n.toLocaleString('en-US');
}

// Whether the detector found `key` already logged on for this run. Its switchFix (detectors/fixes.ts)
// then worded the row's own text for that case and left the property out of the remediation, so
// a generic line reads the same decision and never recommends a switch the row says is on.
// A finding with no remediation (older or hand-built data) keeps the property wording.
export function switchAlreadyOn(finding: { remediation?: Remediation[] }, key: string): boolean {
  return finding.remediation != null && !finding.remediation.some((r) => r.kind === 'conf' && r.key === key);
}

// The fix a known failure message points to (failure-advice.ts), keyed by the property its
// remediation raises. The detectors' recommendation and a failure row's generic line both read it.
export const FAILURE_FIX = {
  'spark.executor.memoryOverhead': 'The cluster manager killed executors that used more memory than their container allows. Raise spark.executor.memoryOverhead, which holds off-heap, native and Python worker memory, or lower spark.executor.cores so fewer tasks share each container.',
  'spark.stage.maxConsecutiveAttempts': 'The stage was aborted after failing its maximum number of consecutive attempts, usually because executors or nodes were lost again and again. Fix the loss first. Raise spark.stage.maxConsecutiveAttempts only to ride out loss that clears on its own.',
} as const;

export function failureFix(f: { remediation?: Remediation[] }): string | undefined {
  const fixes: Record<string, string> = FAILURE_FIX;
  return f.remediation?.map((r) => (r.kind === 'conf' ? fixes[r.key] : undefined)).find((fix) => fix !== undefined);
}

// The properties an idle-capacity finding lowers once dynamic allocation is on, worded as its row
// does: the executor cap, and the floor when the row's remediation lowers it too.
export function idleCapacityLowering(f: { remediation?: Remediation[] }): string {
  const lowersFloor = f.remediation?.some((r) => r.kind === 'conf' && r.key === 'spark.dynamicAllocation.minExecutors');
  return ` by lowering spark.dynamicAllocation.maxExecutors${lowersFloor ? ' and spark.dynamicAllocation.minExecutors' : ''}`;
}

// The shared advice of the two UTIL rows: shrink the cluster, or enable dynamic allocation when it is off.
export function idleCapacityRecommendation(f: { remediation?: Remediation[] }): string {
  return switchAlreadyOn(f, DYNAMIC_ALLOCATION_KEY)
    ? `Dynamic allocation is already on, so consider reducing cluster size${idleCapacityLowering(f)}.`
    : 'Consider either reducing cluster size (spark.executor.instances) or enabling dynamic allocation.';
}

// What a shuffle-reading stage's partition-count advice names, read from the row's remediation: the
// property ('property', also for a finding with no remediation), AQE's coalescing settings ('aqe',
// which leave spark.sql.shuffle.partitions out), or the stage's own repartition(n) ('code').
export function partitionAdviceKind(f: { remediation?: Remediation[] }): 'property' | 'aqe' | 'code' {
  if (f.remediation == null || f.remediation.some((r) => r.kind === 'conf' && r.key === 'spark.sql.shuffle.partitions')) return 'property';
  if (f.remediation.some((r) => r.kind === 'conf' && r.key.startsWith('spark.sql.adaptive.'))) return 'aqe';
  return f.remediation.some((r) => r.kind === 'code') ? 'code' : 'property';
}

// The skew-join line per AQE case, with no instance data (numbers, config values).
export const AQE_SKEW_GENERIC: Readonly<Record<AqeSkewCase, string>> = {
  split: 'AQE skew-join handling already split the skewed partitions, so the imbalance that remains is not join skew: look for a GC pause, a slow host or an expensive key.',
  evenReads: 'The shuffle reads are even, so the slow tail is not partition-size skew and AQE has nothing to split: look for a GC pause, a slow host or an expensive key.',
  belowThreshold: 'The largest partition is under what AQE treats as skewed: lower the skew threshold or factor for this query.',
  planShape: 'An operator sits between the join and its shuffle, so AQE skew-join handling cannot apply: salt the key or repartition on a better key.',
  userRepartition: 'An explicit repartition feeds the join, so AQE leaves its shuffle alone: drop the repartition, or salt the key.',
  joinType: 'The join type does not let AQE split the skewed side: put the skewed table on a splittable side, or salt the key.',
  extraShuffle: 'AQE skipped the split because it would add a shuffle: set spark.sql.adaptive.forceOptimizeSkewedJoin to true if that shuffle is cheaper than the tail, or salt the key.',
  notSplit: 'AQE did not split the skewed partition and the log does not say why: salt the key or repartition on a better key.',
};

// Before Spark 3.3 there is no forceOptimizeSkewedJoin, so an extraShuffle row carries a code fix.
export const AQE_SKEW_EXTRA_SHUFFLE_NO_FORCE = 'AQE skipped the split because it would add a shuffle: salt the key or repartition on a better key.';

export const SKEW_JOIN_KEY = 'spark.sql.adaptive.skewJoin.enabled';

export const SKEW_JOIN_ALREADY_ON = 'AQE skew-join handling is already on, so salt the key or repartition on a better key.';

export const SKEW_JOIN_AQE_OFF = 'AQE is off, so enable it (spark.sql.adaptive.enabled) for skew-join handling to apply; otherwise salt the key or repartition on a better key.';

// The skew-join generic line, worded per the row's remediation: AQE logged off, switch already on, or neither.
export function skewJoinGeneric(f: { remediation?: Remediation[]; origin?: SkewOrigin; aqeSkew?: AqeSkewCase }, unset: string): string {
  if (f.origin === 'inputScan') return 'Uneven input files: compact small files or split large ones (lower spark.sql.files.maxPartitionBytes).';
  if (f.origin === 'other') return 'Work is uneven across tasks: salt the key or repartition on a better key.';
  if (f.aqeSkew === 'extraShuffle' && !f.remediation?.some((r) => r.kind === 'conf')) return AQE_SKEW_EXTRA_SHUFFLE_NO_FORCE;
  if (f.aqeSkew != null) return AQE_SKEW_GENERIC[f.aqeSkew];
  if (f.remediation?.some((r) => r.kind === 'conf' && r.key === 'spark.sql.adaptive.enabled')) return SKEW_JOIN_AQE_OFF;
  return switchAlreadyOn(f, SKEW_JOIN_KEY) ? SKEW_JOIN_ALREADY_ON : unset;
}

export const DYNAMIC_ALLOCATION_KEY = 'spark.dynamicAllocation.enabled';
