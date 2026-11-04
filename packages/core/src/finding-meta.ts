// The per-finding-type tables assembled from the detector folders: the public evidence fields each
// finding type reports and the fields that tell sibling findings apart in their id.
import type { FindingType } from './detectors.ts';
import type { AllKeys, FindingEvidenceMap } from './finding-types.ts';
import type { FindingOf } from './types.ts';
import * as skew from './detectors/skew/detect.ts';
import * as stageShape from './detectors/stage-shape/detect.ts';
import * as shuffle from './detectors/shuffle/detect.ts';
import * as partitionSizing from './detectors/partition-sizing/detect.ts';
import * as spill from './detectors/spill/detect.ts';
import * as gc from './detectors/gc/detect.ts';
import * as slowHost from './detectors/slow-host/detect.ts';
import * as stageSlowness from './detectors/stage-slowness/detect.ts';
import * as stageFailed from './detectors/stage-failed/detect.ts';
import * as failures from './detectors/failures/detect.ts';
import * as straggler from './detectors/straggler/detect.ts';
import * as speculationWaste from './detectors/speculation-waste/detect.ts';
import * as retryWaste from './detectors/retry-waste/detect.ts';
import * as tinyTask from './detectors/tiny-task/detect.ts';
import * as incompleteRun from './detectors/incomplete-run/detect.ts';
import * as coldStart from './detectors/cold-start/detect.ts';
import * as utilization from './detectors/utilization/detect.ts';
import * as rightSizing from './detectors/right-sizing/detect.ts';
import * as memoryUtilization from './detectors/memory-utilization/detect.ts';
import * as cacheUtilization from './detectors/cache-utilization/detect.ts';
import * as coreLocality from './detectors/core-locality/detect.ts';
import * as autoscalingChurn from './detectors/autoscaling-churn/detect.ts';
import * as cachingOpportunity from './detectors/caching-opportunity/detect.ts';
import * as jobFailureRate from './detectors/job-failure-rate/detect.ts';
import * as configAudit from './detectors/config-audit/detect.ts';
import * as duplicatePlanSubtree from './detectors/duplicate-plan-subtree/detect.ts';
import * as smallFiles from './detectors/small-files/detect.ts';
import * as broadcastSizing from './detectors/broadcast-sizing/detect.ts';
import * as pythonUdf from './detectors/python-udf/detect.ts';
import * as nestedLoopJoin from './detectors/nested-loop-join/detect.ts';
import * as mergeRewrite from './detectors/merge-rewrite/detect.ts';
import * as unprunedScan from './detectors/unpruned-scan/detect.ts';
import * as joinKeyCast from './detectors/join-key-cast/detect.ts';

// The id hash's discriminator slots, in join order: reordering or renaming one changes every
// finding id, which needs an EVIDENCE_SCHEMA_VERSION bump.
export const DISCRIMINATOR_SLOTS = [
  'host', 'executorId', 'rule', 'variant', 'dimension',
  'direction', 'nodeName', 'rootName', 'subtreeSize', 'groupIndex', 'largerSideBytes',
  'rddId', 'relation', 'format', 'operator', 'executionIds',
] as const;
// Slots joined after DISCRIMINATOR_SLOTS only for the types that list them, so adding one leaves
// every other finding id unchanged.
export const APPENDED_SLOTS = ['planNodeIds'] as const;
export type DiscriminatorSlot = (typeof DISCRIMINATOR_SLOTS)[number] | (typeof APPENDED_SLOTS)[number];

// Each finding type's public evidence fields: exactly the keys of its FindingEvidenceMap entry,
// checked both ways at compile time. A field a detector adds for another core module (stageShape's
// totalCores, utilization's unrounded fraction) is left off both, so it never reaches the report;
// adding, renaming or dropping a key changes the report contract.
export const EVIDENCE_KEYS = {
  ...skew.evidenceKeys,
  ...stageShape.evidenceKeys,
  ...shuffle.evidenceKeys,
  ...partitionSizing.evidenceKeys,
  ...spill.evidenceKeys,
  ...gc.evidenceKeys,
  ...slowHost.evidenceKeys,
  ...stageSlowness.evidenceKeys,
  ...stageFailed.evidenceKeys,
  ...failures.evidenceKeys,
  ...straggler.evidenceKeys,
  ...speculationWaste.evidenceKeys,
  ...retryWaste.evidenceKeys,
  ...tinyTask.evidenceKeys,
  ...incompleteRun.evidenceKeys,
  ...coldStart.evidenceKeys,
  ...utilization.evidenceKeys,
  ...rightSizing.evidenceKeys,
  ...memoryUtilization.evidenceKeys,
  ...cacheUtilization.evidenceKeys,
  ...coreLocality.evidenceKeys,
  ...autoscalingChurn.evidenceKeys,
  ...cachingOpportunity.evidenceKeys,
  ...jobFailureRate.evidenceKeys,
  ...configAudit.evidenceKeys,
  ...duplicatePlanSubtree.evidenceKeys,
  ...smallFiles.evidenceKeys,
  ...broadcastSizing.evidenceKeys,
  ...pythonUdf.evidenceKeys,
  ...nestedLoopJoin.evidenceKeys,
  ...mergeRewrite.evidenceKeys,
  ...unprunedScan.evidenceKeys,
  ...joinKeyCast.evidenceKeys,
} as const satisfies { [T in FindingType]: readonly AllKeys<FindingEvidenceMap[T]>[] };

// Per type, the fields that tell apart sibling findings sharing one location and metric; without
// them those siblings hash to one id (see detector-contract.md, Finding ids).
export const ID_DISCRIMINATORS = {
  ...skew.idDiscriminators,
  ...stageShape.idDiscriminators,
  ...shuffle.idDiscriminators,
  ...partitionSizing.idDiscriminators,
  ...spill.idDiscriminators,
  ...gc.idDiscriminators,
  ...slowHost.idDiscriminators,
  ...stageSlowness.idDiscriminators,
  ...stageFailed.idDiscriminators,
  ...failures.idDiscriminators,
  ...straggler.idDiscriminators,
  ...speculationWaste.idDiscriminators,
  ...retryWaste.idDiscriminators,
  ...tinyTask.idDiscriminators,
  ...incompleteRun.idDiscriminators,
  ...coldStart.idDiscriminators,
  ...utilization.idDiscriminators,
  ...rightSizing.idDiscriminators,
  ...memoryUtilization.idDiscriminators,
  ...cacheUtilization.idDiscriminators,
  ...coreLocality.idDiscriminators,
  ...autoscalingChurn.idDiscriminators,
  ...cachingOpportunity.idDiscriminators,
  ...jobFailureRate.idDiscriminators,
  ...configAudit.idDiscriminators,
  ...duplicatePlanSubtree.idDiscriminators,
  ...smallFiles.idDiscriminators,
  ...broadcastSizing.idDiscriminators,
  ...pythonUdf.idDiscriminators,
  ...nestedLoopJoin.idDiscriminators,
  ...mergeRewrite.idDiscriminators,
  ...unprunedScan.idDiscriminators,
  ...joinKeyCast.idDiscriminators,
} as const satisfies { [T in FindingType]: readonly (DiscriminatorSlot & AllKeys<FindingOf<T>>)[] };
