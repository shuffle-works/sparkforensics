// Every detector folder's detect module, once, in render order (see widget-rendering.md): its
// position breaks ties between equal `order` values. detectors.ts assembles DETECTORS from it,
// finding-meta.ts EVIDENCE_KEYS and ID_DISCRIMINATORS, and finding-types.ts the Finding union (from
// each module's type-only `emits`) and the member re-exports. A new detector adds its import, its
// member re-export and its entry here.
import * as skew from './skew/detect.ts';
export type { SkewEvidence, SkewFinding } from './skew/detect.ts';
import * as stageShape from './stage-shape/detect.ts';
export type { StageShapeEvidence, StageShapeFinding } from './stage-shape/detect.ts';
import * as shuffle from './shuffle/detect.ts';
export type { ShuffleEvidence, ShuffleFinding } from './shuffle/detect.ts';
import * as partitionSizing from './partition-sizing/detect.ts';
export type { PartitionSizingEvidence, PartitionSizingFinding } from './partition-sizing/detect.ts';
import * as spill from './spill/detect.ts';
export type { SpillOperator, ExchangeWidth, SpillExchange, SpillEvidence, SpillFinding } from './spill/detect.ts';
import * as gc from './gc/detect.ts';
export type { GcEvidence, GcFinding } from './gc/detect.ts';
import * as slowHost from './slow-host/detect.ts';
export type { SlowHostMeanTimeEvidence, SlowHostDurationShareEvidence, SlowHostMultiDimEvidence, SlowHostEvidence, SlowHostMeanTimeFinding, SlowHostDurationShareFinding, SlowHostMultiDimFinding, SlowHostFinding } from './slow-host/detect.ts';
import * as stageSlowness from './stage-slowness/detect.ts';
export type { StageSlownessEvidence, StageSlownessFinding } from './stage-slowness/detect.ts';
import * as stageFailed from './stage-failed/detect.ts';
export type { StageFailedEvidence, StageFailedFinding } from './stage-failed/detect.ts';
import * as failures from './failures/detect.ts';
export type { FailuresEvidence, FailuresFinding } from './failures/detect.ts';
import * as straggler from './straggler/detect.ts';
export type { StragglerEvidence, StragglerFinding } from './straggler/detect.ts';
import * as speculationWaste from './speculation-waste/detect.ts';
export type { SpeculationWasteEvidence, SpeculationWasteFinding } from './speculation-waste/detect.ts';
import * as retryWaste from './retry-waste/detect.ts';
export type { RetryWasteEvidence, RetryWasteFinding } from './retry-waste/detect.ts';
import * as tinyTask from './tiny-task/detect.ts';
export type { TinyTaskEvidence, TinyTaskFinding } from './tiny-task/detect.ts';
import * as incompleteRun from './incomplete-run/detect.ts';
export type { IncompleteRunEvidence, IncompleteRunFinding } from './incomplete-run/detect.ts';
import * as coldStart from './cold-start/detect.ts';
export type { ColdStartEvidence, ColdStartFinding } from './cold-start/detect.ts';
import * as utilization from './utilization/detect.ts';
export type { UtilizationEvidence, UtilizationFinding } from './utilization/detect.ts';
import * as rightSizing from './right-sizing/detect.ts';
export type { RightSizingEvidence, RightSizingFinding } from './right-sizing/detect.ts';
import * as memoryUtilization from './memory-utilization/detect.ts';
export type { MemoryIdleCoresEvidence, MemoryIdleCoresFinding, MemoryBandUnavailableEvidence, MemoryBandUnavailableFinding, MemoryHeapOverProvisionedEvidence, MemoryHeapOverProvisionedFinding, MemoryWasteModelEvidence, MemoryWasteModelFinding, MemoryUtilizationEvidence, MemoryUtilizationFinding } from './memory-utilization/detect.ts';
import * as cacheUtilization from './cache-utilization/detect.ts';
export type { CachePartialCacheEvidence, CacheDiskSpilloverEvidence, CacheStorageUnobservedEvidence, CacheUtilizationEvidence, CachePartialCacheFinding, CacheDiskSpilloverFinding, CacheStorageUnobservedFinding, CacheUtilizationFinding } from './cache-utilization/detect.ts';
import * as coreLocality from './core-locality/detect.ts';
export type { CoreLocalityEvidence, CoreLocalityFinding } from './core-locality/detect.ts';
import * as autoscalingChurn from './autoscaling-churn/detect.ts';
export type { AutoscalingChurnEvidence, AutoscalingChurnFinding } from './autoscaling-churn/detect.ts';
import * as cachingOpportunity from './caching-opportunity/detect.ts';
export type { CachingRelationEvidence, CachingCompositeEvidence, CachingOpportunityEvidence, CachingRelationFinding, CachingCompositeFinding, CachingOpportunityFinding } from './caching-opportunity/detect.ts';
import * as jobFailureRate from './job-failure-rate/detect.ts';
export type { JobFailureRateEvidence, JobFailureRateFinding } from './job-failure-rate/detect.ts';
import * as configAudit from './config-audit/detect.ts';
export type { ConfigAuditEvidence, ConfigAuditFinding } from './config-audit/detect.ts';
import * as duplicatePlanSubtree from './duplicate-plan-subtree/detect.ts';
export type { DuplicatePlanSubtreeEvidence, DuplicatePlanSubtreeFinding } from './duplicate-plan-subtree/detect.ts';
import * as smallFiles from './small-files/detect.ts';
export type { SmallFilesEvidence, SmallFilesFinding } from './small-files/detect.ts';
import * as broadcastSizing from './broadcast-sizing/detect.ts';
export type { BroadcastThreshold, UnderBroadcastEvidence, UnderBroadcastFinding, OverBroadcastEvidence, OverBroadcastFinding } from './broadcast-sizing/detect.ts';
import * as pythonUdf from './python-udf/detect.ts';
export type { PythonUdfEvidence, PythonUdfFinding } from './python-udf/detect.ts';
import * as nestedLoopJoin from './nested-loop-join/detect.ts';
export type { NestedLoopJoinEvidence, NestedLoopJoinFinding } from './nested-loop-join/detect.ts';
import * as mergeRewrite from './merge-rewrite/detect.ts';
export type { MergeRewriteEvidence, MergeRewriteFinding } from './merge-rewrite/detect.ts';
import * as unprunedScan from './unpruned-scan/detect.ts';
export type { UnprunedScanEvidence, UnprunedScanFinding } from './unpruned-scan/detect.ts';
import * as joinKeyCast from './join-key-cast/detect.ts';
export type { JoinKeyCastEvidence, JoinKeyCastFinding } from './join-key-cast/detect.ts';

export default [
  skew,
  stageShape,
  shuffle,
  partitionSizing,
  spill,
  gc,
  slowHost,
  stageSlowness,
  stageFailed,
  failures,
  straggler,
  speculationWaste,
  retryWaste,
  tinyTask,
  incompleteRun,
  coldStart,
  utilization,
  rightSizing,
  memoryUtilization,
  cacheUtilization,
  coreLocality,
  autoscalingChurn,
  cachingOpportunity,
  jobFailureRate,
  configAudit,
  duplicatePlanSubtree,
  smallFiles,
  broadcastSizing,
  pythonUdf,
  nestedLoopJoin,
  mergeRewrite,
  unprunedScan,
  joinKeyCast,
] as const;
