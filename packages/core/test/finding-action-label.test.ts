import { expect, test } from 'vitest';

import type { Finding } from '../src/types';
import { coreFindingActionLabel } from '../src/finding-action-label';

// Core-only counterpart to tests/view/finding-action-label.test.ts: exercises
// the switch directly (no REGISTRY fallback, no React), proving core is safe to
// import from the CLI/MCP path (src/evidence-report.ts) as well as the view.
function finding(overrides: Partial<Finding> & Pick<Finding, 'type'>): Finding {
  return { impactBand: 'warning', ...overrides };
}

test('returns a plain per-type label for a detector with no sub-variants', () => {
  expect(coreFindingActionLabel(finding({ type: 'shuffle' }))).toBe('Reduce shuffle size');
});

test('branches on the rule field for a multi-rule detector', () => {
  expect(coreFindingActionLabel(finding({ type: 'stageShape', rule: 'lowParallelism' }))).toBe('Increase parallelism');
  expect(coreFindingActionLabel(finding({ type: 'stageShape', rule: 'dataExplosion' }))).toBe('Check for exploding join');
  expect(coreFindingActionLabel(finding({ type: 'stageShape', rule: 'taskStageSkew' }))).toBe('Fix straggler task');
});

test('branches on the direction field for gc, distinguishing high-GC from low-GC/cost findings', () => {
  expect(coreFindingActionLabel(finding({ type: 'gc' }))).toBe('Reduce GC pressure');
  expect(coreFindingActionLabel(finding({ type: 'gc', direction: 'low' }))).toBe('Right-size executor memory');
});

test('branches on the property field for configAudit', () => {
  expect(coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.serializer' }))).toBe('Switch to Kryo');
  expect(coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.executor.memoryOverhead' }))).toBe(
    'Raise memory overhead',
  );
});

test('branches on the variant (and rule/dataUnavailable) fields for memoryUtilization', () => {
  expect(coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'idleCores' }))).toBe('Reduce idle cores');
  expect(coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'wasteModel' }))).toBe(
    'Right-size executor memory',
  );
  expect(coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'notARealVariant' }))).toBeUndefined();
  expect(
    coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true })),
  ).toBe('Enable memory metrics');
  expect(
    coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity' })),
  ).toBe('Increase executor memory');
  expect(
    coreFindingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned' })),
  ).toBe('Reduce executor memory');
});

test('branches on the rule field for partitionSizing', () => {
  expect(coreFindingActionLabel(finding({ type: 'partitionSizing', rule: 'shufflePartitionSkew' }))).toBe('Fix skewed partition');
  expect(coreFindingActionLabel(finding({ type: 'partitionSizing', rule: 'lowShuffleParallelism' }))).toBe('Add shuffle partitions');
  expect(coreFindingActionLabel(finding({ type: 'partitionSizing', rule: 'maxPartitionTooBig' }))).toBe('Repartition oversized data');
  expect(coreFindingActionLabel(finding({ type: 'partitionSizing', rule: 'notARealRule' }))).toBeUndefined();
});

test('branches on the variant field for slowHost, falling back to a generic label for any other variant', () => {
  expect(coreFindingActionLabel(finding({ type: 'slowHost', variant: 'durationShare' }))).toBe('Fix data locality');
  expect(coreFindingActionLabel(finding({ type: 'slowHost', variant: 'multiDim' }))).toBe('Investigate degraded executor');
  expect(coreFindingActionLabel(finding({ type: 'slowHost' }))).toBe('Check slow host');
});

test('branches on the variant field for cachingOpportunity', () => {
  expect(coreFindingActionLabel(finding({ type: 'cachingOpportunity', variant: 'composite' }))).toBe('Cache repeated result');
  expect(coreFindingActionLabel(finding({ type: 'cachingOpportunity', variant: 'single' }))).toBe('Cache shared table');
});

test('branches on the direction field for smallFiles', () => {
  expect(coreFindingActionLabel(finding({ type: 'smallFiles', direction: 'write' }))).toBe('Coalesce output files');
  expect(coreFindingActionLabel(finding({ type: 'smallFiles', direction: 'read' }))).toBe('Compact small files');
});

test('returns a plain per-type label for every remaining single-branch detector type', () => {
  expect(coreFindingActionLabel(finding({ type: 'spill' }))).toBe('Reduce spill');
  expect(coreFindingActionLabel(finding({ type: 'stageSlowness' }))).toBe('Profile slow stage');
  expect(coreFindingActionLabel(finding({ type: 'stageFailed' }))).toBe('Inspect stage failure');
  expect(coreFindingActionLabel(finding({ type: 'failures' }))).toBe('Investigate task failures');
  expect(coreFindingActionLabel(finding({ type: 'straggler' }))).toBe('Fix stragglers');
  expect(coreFindingActionLabel(finding({ type: 'speculationWaste' }))).toBe('Tune speculation settings');
  expect(coreFindingActionLabel(finding({ type: 'retryWaste' }))).toBe('Investigate retry cause');
  expect(coreFindingActionLabel(finding({ type: 'tinyTask' }))).toBe('Coalesce small tasks');
  expect(coreFindingActionLabel(finding({ type: 'coldStart' }))).toBe('Pre-warm cluster');
  expect(coreFindingActionLabel(finding({ type: 'utilization' }))).toBe('Reduce cluster size');
  expect(coreFindingActionLabel(finding({ type: 'cacheUtilization' }))).toBe('Increase cache memory');
  expect(coreFindingActionLabel(finding({ type: 'cacheUtilization', variant: 'storageUnobserved', dataUnavailable: true })))
    .toBe('Enable block-update logging');
  expect(coreFindingActionLabel(finding({ type: 'coreLocality' }))).toBe('Fix data locality');
  expect(coreFindingActionLabel(finding({ type: 'autoscalingChurn' }))).toBe('Reduce autoscaling churn');
  expect(coreFindingActionLabel(finding({ type: 'jobFailureRate' }))).toBe('Investigate failed jobs');
  expect(coreFindingActionLabel(finding({ type: 'duplicatePlanSubtree' }))).toBe('Dedupe repeated subtree');
  expect(coreFindingActionLabel(finding({ type: 'underBroadcast' }))).toBe('Use broadcast join');
  expect(coreFindingActionLabel(finding({ type: 'overBroadcast' }))).toBe('Fix oversized broadcast');
});

test('branches on the property field for the remaining configAudit properties', () => {
  expect(coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.shuffle.service.enabled' }))).toBe(
    'Enable shuffle service',
  );
  expect(
    coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.minExecutors' })),
  ).toBe('Fix autoscaling bounds');
  expect(
    coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors' })),
  ).toBe('Set max executors');
});

test('returns undefined (not a fallback string) for an unrecognized configAudit property', () => {
  expect(coreFindingActionLabel(finding({ type: 'configAudit', property: 'spark.sql.shuffle.partitions' }))).toBeUndefined();
});

test('returns undefined (not a fallback string) for an unrecognized stageShape rule', () => {
  expect(coreFindingActionLabel(finding({ type: 'stageShape', rule: 'notARealRule' }))).toBeUndefined();
});

test('returns undefined for a type with no case in the switch at all', () => {
  expect(coreFindingActionLabel(finding({ type: 'incompleteRun' }))).toBeUndefined();
  expect(coreFindingActionLabel(finding({ type: 'notARealDetector' }))).toBeUndefined();
});
