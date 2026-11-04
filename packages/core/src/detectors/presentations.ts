// Every detector folder's presentation module, once. finding-presentation.ts assembles
// FINDING_PRESENTATION from it in this order. A new detector adds its import and its entry here, and
// its presentation.ts to ALLOWED_EXPORT_CORE_MODULES (scripts/export-analysis-guard.mjs).
import * as incompleteRun from './incomplete-run/presentation.ts';
import * as skew from './skew/presentation.ts';
import * as stageShape from './stage-shape/presentation.ts';
import * as tinyTask from './tiny-task/presentation.ts';
import * as shuffle from './shuffle/presentation.ts';
import * as partitionSizing from './partition-sizing/presentation.ts';
import * as spill from './spill/presentation.ts';
import * as gc from './gc/presentation.ts';
import * as stageFailed from './stage-failed/presentation.ts';
import * as failures from './failures/presentation.ts';
import * as retryWaste from './retry-waste/presentation.ts';
import * as slowHost from './slow-host/presentation.ts';
import * as stageSlowness from './stage-slowness/presentation.ts';
import * as straggler from './straggler/presentation.ts';
import * as speculationWaste from './speculation-waste/presentation.ts';
import * as coldStart from './cold-start/presentation.ts';
import * as memoryUtilization from './memory-utilization/presentation.ts';
import * as utilization from './utilization/presentation.ts';
import * as rightSizing from './right-sizing/presentation.ts';
import * as coreLocality from './core-locality/presentation.ts';
import * as cachingOpportunity from './caching-opportunity/presentation.ts';
import * as cacheUtilization from './cache-utilization/presentation.ts';
import * as jobFailureRate from './job-failure-rate/presentation.ts';
import * as autoscalingChurn from './autoscaling-churn/presentation.ts';
import * as configAudit from './config-audit/presentation.ts';
import * as duplicatePlanSubtree from './duplicate-plan-subtree/presentation.ts';
import * as smallFiles from './small-files/presentation.ts';
import * as pythonUdf from './python-udf/presentation.ts';
import * as nestedLoopJoin from './nested-loop-join/presentation.ts';
import * as joinKeyCast from './join-key-cast/presentation.ts';
import * as mergeRewrite from './merge-rewrite/presentation.ts';
import * as unprunedScan from './unpruned-scan/presentation.ts';
import * as broadcastSizing from './broadcast-sizing/presentation.ts';

export default [
  incompleteRun,
  skew,
  stageShape,
  tinyTask,
  shuffle,
  partitionSizing,
  spill,
  gc,
  stageFailed,
  failures,
  retryWaste,
  slowHost,
  stageSlowness,
  straggler,
  speculationWaste,
  coldStart,
  memoryUtilization,
  utilization,
  rightSizing,
  coreLocality,
  cachingOpportunity,
  cacheUtilization,
  jobFailureRate,
  autoscalingChurn,
  configAudit,
  duplicatePlanSubtree,
  smallFiles,
  pythonUdf,
  nestedLoopJoin,
  joinKeyCast,
  mergeRewrite,
  unprunedScan,
  broadcastSizing,
] as const;
