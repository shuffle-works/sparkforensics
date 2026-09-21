import { expect, test } from 'vitest';

import type { Finding } from '../src/types';
import { coreFindingGenericRecommendation } from '../src/finding-generic-recommendation';

// Mirrors finding-action-label.test.ts's shape: exercises the (type, discriminant) switch
// directly, proving every generic sentence is free of instance data (no numbers, stage ids,
// host names, file counts) so it's safe to show once for a whole multi-finding group instead
// of one member's own specific `recommendation`.
function finding(overrides: Partial<Finding> & Pick<Finding, 'type'>): Finding {
  return { impactBand: 'warning', ...overrides };
}

const NO_DIGITS = /\d/;

test('returns a plain per-type sentence for a detector with no sub-variants', () => {
  const text = coreFindingGenericRecommendation(finding({ type: 'shuffle' }));
  expect(text).toMatch(/spark\.sql\.shuffle\.partitions/);
  expect(text).not.toMatch(NO_DIGITS);
});

test('branches on the rule field for stageShape, each free of the instance stage/core counts', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'stageShape', rule: 'lowParallelism' })))
    .toMatch(/under-parallelized|idle/);
  expect(coreFindingGenericRecommendation(finding({ type: 'stageShape', rule: 'dataExplosion' })))
    .toMatch(/exploding join|cross product/);
  expect(coreFindingGenericRecommendation(finding({ type: 'stageShape', rule: 'taskStageSkew' })))
    .toMatch(/straggler/);
});

test('branches on the rule field for partitionSizing', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'partitionSizing', rule: 'shufflePartitionSkew' })))
    .toMatch(/AQE skew-join|salt the key/);
  expect(coreFindingGenericRecommendation(finding({ type: 'partitionSizing', rule: 'lowShuffleParallelism' })))
    .toMatch(/spark\.sql\.shuffle\.partitions/);
  expect(coreFindingGenericRecommendation(finding({ type: 'partitionSizing', rule: 'maxPartitionTooBig' })))
    .toMatch(/[Rr]epartition/);
});

test('gives spill one combined sentence covering both the skew and non-skew fixes (classification is not a stored field)', () => {
  const text = coreFindingGenericRecommendation(finding({ type: 'spill' }));
  expect(text).toMatch(/skew/);
  expect(text).toMatch(/spark\.sql\.shuffle\.partitions|executor memory/);
});

test('branches on the direction field for gc, distinguishing high-GC from low-GC/cost findings', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'gc' }))).toMatch(/GC|garbage/i);
  expect(coreFindingGenericRecommendation(finding({ type: 'gc', direction: 'low' })))
    .toMatch(/over-provisioned/);
});

test('branches on the variant field for slowHost', () => {
  // Per slow-host.md's own "Limitations" section, a slow host isn't necessarily a hardware
  // fault: it may just hold data locality for its tasks or carry one heavy stage.
  expect(coreFindingGenericRecommendation(finding({ type: 'slowHost' })))
    .toMatch(/data locality|heavy stage/);
  expect(coreFindingGenericRecommendation(finding({ type: 'slowHost', variant: 'durationShare' })))
    .toMatch(/data locality|partition assignment/);
  expect(coreFindingGenericRecommendation(finding({ type: 'slowHost', variant: 'multiDim' })))
    .toMatch(/uneven partition assignment|degraded executor/);
});

test('returns a stable, instance-free sentence for every simple single-branch type', () => {
  const simpleTypes: Finding['type'][] = [
    'stageSlowness', 'stageFailed', 'failures', 'straggler', 'speculationWaste', 'retryWaste',
    'tinyTask', 'coldStart', 'utilization', 'coreLocality', 'autoscalingChurn', 'jobFailureRate',
    'duplicatePlanSubtree', 'underBroadcast', 'overBroadcast',
  ];
  for (const type of simpleTypes) {
    const text = coreFindingGenericRecommendation(finding({ type }));
    expect(text, `expected a sentence for type ${type}`).toBeTruthy();
    expect(text, `expected no digits for type ${type}`).not.toMatch(NO_DIGITS);
  }
});

test('branches on the property field for configAudit', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.shuffle.service.enabled' })))
    .toMatch(/spark\.shuffle\.service\.enabled=true/);
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.minExecutors' })))
    .toMatch(/minimum.*maximum|min.*max/i);
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors' })))
    .toMatch(/spark\.dynamicAllocation\.maxExecutors/);
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.serializer' })))
    .toMatch(/KryoSerializer/);
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.executor.memoryOverhead' })))
    .toMatch(/memoryOverhead/);
});

test('branches on the variant (and rule) fields for memoryUtilization', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'memoryUtilization', variant: 'idleCores' })))
    .toMatch(/[Rr]educe cluster size|dynamic allocation/);
  expect(coreFindingGenericRecommendation(finding({ type: 'memoryUtilization', variant: 'wasteModel' })))
    .toMatch(/spark\.executor\.memory/);
  expect(coreFindingGenericRecommendation(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity' })))
    .toMatch(/raise spark\.executor\.memory/i);
  expect(coreFindingGenericRecommendation(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned' })))
    .toMatch(/over-provisioned/);
});

test('a memoryUtilization memoryBand finding reporting dataUnavailable has no generic sentence (excluded upstream by isEligible anyway)', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true }))).toBeUndefined();
});

test('branches on the variant field for cacheUtilization', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'cacheUtilization', variant: 'partialCache' })))
    .toMatch(/executor memory|cached dataset/);
  expect(coreFindingGenericRecommendation(finding({ type: 'cacheUtilization', variant: 'diskSpillover' })))
    .toMatch(/executor memory/);
});

test('branches on the variant field for cachingOpportunity', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'cachingOpportunity' })))
    .toMatch(/[Cc]ache|broadcast/);
  expect(coreFindingGenericRecommendation(finding({ type: 'cachingOpportunity', variant: 'composite' })))
    .toMatch(/join\/union|[Cc]ache/);
});

test('branches on the direction field for smallFiles', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'smallFiles', direction: 'read' })))
    .toMatch(/compact/i);
  expect(coreFindingGenericRecommendation(finding({ type: 'smallFiles', direction: 'write' })))
    .toMatch(/[Rr]epartition|coalesce/);
});

test('returns undefined (not a fallback string) for an unrecognized configAudit property', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'configAudit', property: 'spark.sql.shuffle.partitions' }))).toBeUndefined();
});

test('returns undefined (not a fallback string) for an unrecognized stageShape rule', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'stageShape', rule: 'notARealRule' }))).toBeUndefined();
});

test('returns undefined for a type with no case in the switch at all', () => {
  expect(coreFindingGenericRecommendation(finding({ type: 'incompleteRun' }))).toBeUndefined();
  expect(coreFindingGenericRecommendation(finding({ type: 'notARealDetector' }))).toBeUndefined();
});
