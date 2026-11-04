// The finding shapes. Each detector folder (detectors/<type>/detect.ts) declares its own members:
// `<Type>Evidence` is the public part, the fields the evidence report publishes (the folder's
// `evidenceKeys` must list every one of them), and anything declared only on `<Type>Finding` is
// internal, read by another core module (the impact estimator, mostly) and never published.
// Renaming or removing an evidence field is a breaking change to the report and needs an
// EVIDENCE_SCHEMA_VERSION bump.
//
// This module holds what several detectors share, re-exports every member so the `types` entry
// point exports them, and assembles `Finding`, a union discriminated on `type`, from each folder's
// `Emits`. `FindingType` (detectors.ts) derives the same set from `DETECTORS`' `emits` lists, and a
// compile-time check there keeps the two equal.

import type * as skew from './detectors/skew/detect.ts';
import type * as stageShape from './detectors/stage-shape/detect.ts';
import type * as shuffle from './detectors/shuffle/detect.ts';
import type * as partitionSizing from './detectors/partition-sizing/detect.ts';
import type * as spill from './detectors/spill/detect.ts';
import type * as gc from './detectors/gc/detect.ts';
import type * as slowHost from './detectors/slow-host/detect.ts';
import type * as stageSlowness from './detectors/stage-slowness/detect.ts';
import type * as stageFailed from './detectors/stage-failed/detect.ts';
import type * as failures from './detectors/failures/detect.ts';
import type * as straggler from './detectors/straggler/detect.ts';
import type * as speculationWaste from './detectors/speculation-waste/detect.ts';
import type * as retryWaste from './detectors/retry-waste/detect.ts';
import type * as tinyTask from './detectors/tiny-task/detect.ts';
import type * as incompleteRun from './detectors/incomplete-run/detect.ts';
import type * as coldStart from './detectors/cold-start/detect.ts';
import type * as utilization from './detectors/utilization/detect.ts';
import type * as rightSizing from './detectors/right-sizing/detect.ts';
import type * as memoryUtilization from './detectors/memory-utilization/detect.ts';
import type * as cacheUtilization from './detectors/cache-utilization/detect.ts';
import type * as coreLocality from './detectors/core-locality/detect.ts';
import type * as autoscalingChurn from './detectors/autoscaling-churn/detect.ts';
import type * as cachingOpportunity from './detectors/caching-opportunity/detect.ts';
import type * as jobFailureRate from './detectors/job-failure-rate/detect.ts';
import type * as configAudit from './detectors/config-audit/detect.ts';
import type * as duplicatePlanSubtree from './detectors/duplicate-plan-subtree/detect.ts';
import type * as smallFiles from './detectors/small-files/detect.ts';
import type * as mergeRewrite from './detectors/merge-rewrite/detect.ts';
import type * as unprunedScan from './detectors/unpruned-scan/detect.ts';
import type * as pythonUdf from './detectors/python-udf/detect.ts';
import type * as nestedLoopJoin from './detectors/nested-loop-join/detect.ts';
import type * as joinKeyCast from './detectors/join-key-cast/detect.ts';
import type * as broadcastSizing from './detectors/broadcast-sizing/detect.ts';

/** One concrete change a finding's fix makes, alongside its prose `recommendation`. Entries are
 * applied together unless the recommendation words them as alternatives ("either ... or"), as an
 * idle-capacity finding does with dynamic allocation off: then a consumer applies one. */
export type Remediation = ConfRemediation | CodeRemediation;

/** A Spark property the detector already names; `suggested` is null when it computes no value.
 * Sizes carry a Spark unit suffix ("384m"), counts are plain numbers, switches are booleans. */
export interface ConfRemediation {
  kind: 'conf';
  key: string;
  direction: 'increase' | 'decrease' | 'set';
  suggested: number | string | boolean | null;
}

/** A fix no Spark property makes: the job's code or data has to change. `hint` is the same
 * wording the finding's `recommendation` gives. */
export interface CodeRemediation {
  kind: 'code';
  hint: string;
}

/** One overridden threshold: the value the detector ran with, and its specification default. */
export interface TunedThreshold {
  value: number | readonly number[];
  default: number | readonly number[];
}

export type TunedThresholds = Readonly<Record<string, TunedThreshold>>;

// A failed or retried task attempt, as a stage keeps a bounded sample of them.
export interface TaskAttemptSample {
  taskId: number | null;
  attemptNumber: number;
  host: string;
  executorId: string;
  reason: string | null;
  peakExecMem: number;
  memSpilled: number;
  shuffleWrite: number;
}

/** What a skewed stage reads, which decides the fix: 'shuffleJoin' (a shuffle feeding a join, where
 * AQE skew-join handling applies), 'inputScan' (uneven input files) or 'other'. */
export type SkewOrigin = 'shuffleJoin' | 'inputScan' | 'other';

/** What AQE skew-join handling did for a 'shuffleJoin' stage, read from the final plan and the
 * effective conf: 'split' (it split the skewed partition, so the rest is not join skew),
 * 'evenReads' (the shuffle reads are even, so no partition is skewed for AQE to split),
 * 'belowThreshold' (the partition is under the effective skew threshold or factor), 'planShape' (an
 * operator sits between the join and its shuffle), 'userRepartition' (the shuffle is an explicit
 * repartition), 'joinType' (the join type does not let AQE split the skewed side),
 * 'extraShuffle' (splitting would add a shuffle for the operator above the join) or 'notSplit'
 * (nothing in the log explains it). */
export type AqeSkewCase = 'split' | 'evenReads' | 'belowThreshold' | 'planShape' | 'userRepartition' | 'joinType' | 'extraShuffle' | 'notSplit';

/** What a stage reads, by the dominant side: a shuffle, input files, or neither. */
export type StageReads = 'shuffle' | 'input' | 'other';

/** Why a shuffle finding's partition-count advice is or is not given: 'raise' (the property limits
 * the stage), 'sufficient' (tasks are already a good size), 'aqeCoalesced' (AQE merged the
 * partitions, so the advisory size is the lever) or 'ownPartitioning' (the property did not size
 * the stage, so the stage's own repartition(n) or RDD parallelism is the lever). */
export type ShufflePartitions = 'raise' | 'sufficient' | 'aqeCoalesced' | 'ownPartitioning';

/** Why a stage's slow tail is slow (attributeTail in stage-quantiles.ts). 'data': the slow tasks
 * read far more than the median task, so run time follows data volume. 'gc', 'fetchWait' and
 * 'host': the tail's extra time is GC, shuffle fetch wait, or tasks piled on one host.
 * 'unexplained': the slow tasks read no more than the median and none of those accounts for their
 * time. 'unattributed': the stage has no data volume to compare and what data, GC, fetch wait and
 * host do not explain is the largest share (or the stage has no tail attribution), so only the
 * duration is known. */
export type TailCause = 'data' | 'gc' | 'fetchWait' | 'host' | 'unexplained' | 'unattributed';

/** Every key of any member of a union: `keyof` alone sees only the keys the members share. */
export type AllKeys<U> = U extends unknown ? keyof U : never;

/** The finding member for one `type`. */
export type FindingOf<T extends Finding['type']> = Extract<Finding, { type: T }>;

export type { SpillOperator, ExchangeWidth, SpillExchange, SpillEvidence, SpillFinding } from './detectors/spill/detect.ts';
export type { GcEvidence, GcFinding } from './detectors/gc/detect.ts';
export type { StageShapeEvidence, StageShapeFinding } from './detectors/stage-shape/detect.ts';
export type { ShuffleEvidence, ShuffleFinding } from './detectors/shuffle/detect.ts';
export type { PartitionSizingEvidence, PartitionSizingFinding } from './detectors/partition-sizing/detect.ts';
export type { StageSlownessEvidence, StageSlownessFinding } from './detectors/stage-slowness/detect.ts';
export type { TinyTaskEvidence, TinyTaskFinding } from './detectors/tiny-task/detect.ts';
export type { ColdStartEvidence, ColdStartFinding } from './detectors/cold-start/detect.ts';
export type { SlowHostMeanTimeEvidence, SlowHostDurationShareEvidence, SlowHostMultiDimEvidence, SlowHostEvidence, SlowHostMeanTimeFinding, SlowHostDurationShareFinding, SlowHostMultiDimFinding, SlowHostFinding } from './detectors/slow-host/detect.ts';
export type { StragglerEvidence, StragglerFinding } from './detectors/straggler/detect.ts';
export type { SkewEvidence, SkewFinding } from './detectors/skew/detect.ts';
export type { SpeculationWasteEvidence, SpeculationWasteFinding } from './detectors/speculation-waste/detect.ts';
export type { FailuresEvidence, FailuresFinding } from './detectors/failures/detect.ts';
export type { StageFailedEvidence, StageFailedFinding } from './detectors/stage-failed/detect.ts';
export type { RetryWasteEvidence, RetryWasteFinding } from './detectors/retry-waste/detect.ts';
export type { JobFailureRateEvidence, JobFailureRateFinding } from './detectors/job-failure-rate/detect.ts';
export type { MemoryIdleCoresEvidence, MemoryIdleCoresFinding, MemoryBandUnavailableEvidence, MemoryBandUnavailableFinding, MemoryHeapOverProvisionedEvidence, MemoryHeapOverProvisionedFinding, MemoryWasteModelEvidence, MemoryWasteModelFinding, MemoryUtilizationEvidence, MemoryUtilizationFinding } from './detectors/memory-utilization/detect.ts';
export type { CachePartialCacheEvidence, CacheDiskSpilloverEvidence, CacheStorageUnobservedEvidence, CacheUtilizationEvidence, CachePartialCacheFinding, CacheDiskSpilloverFinding, CacheStorageUnobservedFinding, CacheUtilizationFinding } from './detectors/cache-utilization/detect.ts';
export type { CoreLocalityEvidence, CoreLocalityFinding } from './detectors/core-locality/detect.ts';
export type { UtilizationEvidence, UtilizationFinding } from './detectors/utilization/detect.ts';
export type { RightSizingEvidence, RightSizingFinding } from './detectors/right-sizing/detect.ts';
export type { AutoscalingChurnEvidence, AutoscalingChurnFinding } from './detectors/autoscaling-churn/detect.ts';
export type { CachingRelationEvidence, CachingCompositeEvidence, CachingOpportunityEvidence, CachingRelationFinding, CachingCompositeFinding, CachingOpportunityFinding } from './detectors/caching-opportunity/detect.ts';
export type { BroadcastThreshold, UnderBroadcastEvidence, UnderBroadcastFinding, OverBroadcastEvidence, OverBroadcastFinding } from './detectors/broadcast-sizing/detect.ts';
export type { DuplicatePlanSubtreeEvidence, DuplicatePlanSubtreeFinding } from './detectors/duplicate-plan-subtree/detect.ts';
export type { PythonUdfEvidence, PythonUdfFinding } from './detectors/python-udf/detect.ts';
export type { SmallFilesEvidence, SmallFilesFinding } from './detectors/small-files/detect.ts';
export type { NestedLoopJoinEvidence, NestedLoopJoinFinding } from './detectors/nested-loop-join/detect.ts';
export type { MergeRewriteEvidence, MergeRewriteFinding } from './detectors/merge-rewrite/detect.ts';
export type { UnprunedScanEvidence, UnprunedScanFinding } from './detectors/unpruned-scan/detect.ts';
export type { JoinKeyCastEvidence, JoinKeyCastFinding } from './detectors/join-key-cast/detect.ts';
export type { ConfigAuditEvidence, ConfigAuditFinding } from './detectors/config-audit/detect.ts';
export type { IncompleteRunEvidence, IncompleteRunFinding } from './detectors/incomplete-run/detect.ts';

/** What every detector emits, merged from the detector folders. */
type Emitted =
  skew.Emits &
  stageShape.Emits &
  shuffle.Emits &
  partitionSizing.Emits &
  spill.Emits &
  gc.Emits &
  slowHost.Emits &
  stageSlowness.Emits &
  stageFailed.Emits &
  failures.Emits &
  straggler.Emits &
  speculationWaste.Emits &
  retryWaste.Emits &
  tinyTask.Emits &
  incompleteRun.Emits &
  coldStart.Emits &
  utilization.Emits &
  rightSizing.Emits &
  memoryUtilization.Emits &
  cacheUtilization.Emits &
  coreLocality.Emits &
  autoscalingChurn.Emits &
  cachingOpportunity.Emits &
  jobFailureRate.Emits &
  configAudit.Emits &
  duplicatePlanSubtree.Emits &
  smallFiles.Emits &
  mergeRewrite.Emits &
  unprunedScan.Emits &
  pythonUdf.Emits &
  nestedLoopJoin.Emits &
  joinKeyCast.Emits &
  broadcastSizing.Emits;

/** Public evidence fields per finding type: what a report row's `evidence` carries. */
export type FindingEvidenceMap = { [T in keyof Emitted]: Emitted[T]['evidence'] };

export type Finding = Emitted[keyof Emitted]['finding'];
