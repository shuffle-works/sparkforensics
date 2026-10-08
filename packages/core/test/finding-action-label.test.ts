import { expect, test } from 'vitest';

import type { Finding } from '../src/types';
import { findingActionLabel } from '../src/finding-action-label';

// The one action-label function the dashboard, the run verdict and the
// evidence report share: each type's FINDING_PRESENTATION row, then the type's
// name for a combination the row doesn't recognize.
function finding(overrides: Partial<Finding> & Pick<Finding, 'type'>): Finding {
  return { impactBand: 'warning', ...overrides };
}

test('returns a plain per-type label for a detector with no sub-variants', () => {
  expect(findingActionLabel(finding({ type: 'shuffle' }))).toBe('Reduce shuffle size');
});

test('branches on the rule field for a multi-rule detector', () => {
  expect(findingActionLabel(finding({ type: 'stageShape', rule: 'lowParallelism' }))).toBe('Increase parallelism');
  expect(findingActionLabel(finding({ type: 'stageShape', rule: 'dataExplosion' }))).toBe('Check for exploding join');
  expect(findingActionLabel(finding({ type: 'stageShape', rule: 'taskStageSkew' }))).toBe('Fix straggler task');
});

test('branches on the direction field for gc, distinguishing high-GC from low-GC/cost findings', () => {
  expect(findingActionLabel(finding({ type: 'gc' }))).toBe('Reduce GC pressure');
  expect(findingActionLabel(finding({ type: 'gc', direction: 'low' }))).toBe('Right-size executor memory');
});

test('branches on the property field for configAudit', () => {
  expect(findingActionLabel(finding({ type: 'configAudit', property: 'spark.serializer' }))).toBe('Switch to Kryo');
  expect(findingActionLabel(finding({ type: 'configAudit', property: 'spark.executor.memoryOverhead' }))).toBe(
    'Raise memory overhead',
  );
});

test('branches on the variant (and rule/dataUnavailable) fields for memoryUtilization', () => {
  expect(findingActionLabel(finding({ type: 'memoryUtilization', variant: 'idleCores' }))).toBe('Reduce idle cores');
  expect(findingActionLabel(finding({ type: 'memoryUtilization', variant: 'wasteModel' }))).toBe(
    'Right-size executor memory',
  );
  expect(findingActionLabel(finding({ type: 'memoryUtilization', variant: 'notARealVariant' }))).toBe('memory utilization');
  expect(
    findingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true })),
  ).toBe('Enable memory metrics');
  expect(
    findingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned' })),
  ).toBe('Reduce executor memory');
});

test('branches on the rule field for partitionSizing', () => {
  expect(findingActionLabel(finding({ type: 'partitionSizing', rule: 'shufflePartitionSkew' }))).toBe('Fix skewed partition');
  expect(findingActionLabel(finding({ type: 'partitionSizing', rule: 'lowShuffleParallelism' }))).toBe('Add shuffle partitions');
  expect(findingActionLabel(finding({ type: 'partitionSizing', rule: 'maxPartitionTooBig' }))).toBe('Repartition oversized data');
  expect(findingActionLabel(finding({ type: 'partitionSizing', rule: 'notARealRule' }))).toBe('partition sizing');
});

test('branches on the variant field for slowHost, falling back to a generic label for any other variant', () => {
  expect(findingActionLabel(finding({ type: 'slowHost', variant: 'durationShare' }))).toBe('Fix data locality');
  expect(findingActionLabel(finding({ type: 'slowHost', variant: 'multiDim' }))).toBe('Investigate degraded executor');
  expect(findingActionLabel(finding({ type: 'slowHost' }))).toBe('Check slow host');
});

test('branches on the variant field for cachingOpportunity', () => {
  expect(findingActionLabel(finding({ type: 'cachingOpportunity', variant: 'composite' }))).toBe('Cache repeated result');
  expect(findingActionLabel(finding({ type: 'cachingOpportunity', variant: 'single' }))).toBe('Cache shared table');
});

test('branches on the direction field for smallFiles', () => {
  expect(findingActionLabel(finding({ type: 'smallFiles', direction: 'write' }))).toBe('Coalesce output files');
  expect(findingActionLabel(finding({ type: 'smallFiles', direction: 'read' }))).toBe('Compact small files');
});

test('returns a plain per-type label for every remaining single-branch detector type', () => {
  expect(findingActionLabel(finding({ type: 'spill' }))).toBe('Reduce spill');
  expect(findingActionLabel(finding({ type: 'stageSlowness' }))).toBe('Profile slow stage');
  expect(findingActionLabel(finding({ type: 'stageFailed' }))).toBe('Inspect stage failure');
  expect(findingActionLabel(finding({ type: 'failures' }))).toBe('Investigate task failures');
  expect(findingActionLabel(finding({ type: 'straggler' }))).toBe('Fix stragglers');
  expect(findingActionLabel(finding({ type: 'speculationWaste' }))).toBe('Tune speculation settings');
  expect(findingActionLabel(finding({ type: 'retryWaste' }))).toBe('Investigate retry cause');
  expect(findingActionLabel(finding({ type: 'tinyTask' }))).toBe('Coalesce small tasks');
  expect(findingActionLabel(finding({ type: 'coldStart' }))).toBe('Pre-warm cluster');
  expect(findingActionLabel(finding({ type: 'utilization' }))).toBe('Reduce cluster size');
  expect(findingActionLabel(finding({ type: 'cacheUtilization' }))).toBe('Increase cache memory');
  expect(findingActionLabel(finding({ type: 'cacheUtilization', variant: 'storageUnobserved', dataUnavailable: true })))
    .toBe('Enable block-update logging');
  expect(findingActionLabel(finding({ type: 'coreLocality' }))).toBe('Fix data locality');
  expect(findingActionLabel(finding({ type: 'autoscalingChurn' }))).toBe('Reduce autoscaling churn');
  expect(findingActionLabel(finding({ type: 'jobFailureRate' }))).toBe('Investigate failed jobs');
  expect(findingActionLabel(finding({ type: 'duplicatePlanSubtree' }))).toBe('Dedupe repeated subtree');
  expect(findingActionLabel(finding({ type: 'underBroadcast' }))).toBe('Use broadcast join');
  expect(findingActionLabel(finding({ type: 'overBroadcast' }))).toBe('Fix oversized broadcast');
});

test('branches on the property field for the remaining configAudit properties', () => {
  expect(findingActionLabel(finding({ type: 'configAudit', property: 'spark.shuffle.service.enabled' }))).toBe(
    'Enable shuffle service',
  );
  expect(
    findingActionLabel(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.minExecutors' })),
  ).toBe('Fix autoscaling bounds');
  expect(
    findingActionLabel(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors' })),
  ).toBe('Set max executors');
});

test('falls back to the type name for an unrecognized configAudit property', () => {
  expect(findingActionLabel(finding({ type: 'configAudit', property: 'spark.sql.shuffle.partitions' }))).toBe('config audit');
});

test('falls back to the type name for an unrecognized stageShape rule', () => {
  expect(findingActionLabel(finding({ type: 'stageShape', rule: 'notARealRule' }))).toBe('stage shape');
});

test('falls back to the name for a type with no action label, and to the raw type for an unknown type', () => {
  expect(findingActionLabel(finding({ type: 'incompleteRun' }))).toBe('incomplete run');
  expect(findingActionLabel(finding({ type: 'notARealDetector' }))).toBe('notARealDetector');
});
