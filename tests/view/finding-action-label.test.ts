import { expect, test } from 'vitest';

import type { Finding } from '@sparkforensics/core/types.ts';
import { findingActionLabel } from '../../src/view/finding-action-label';

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
  expect(
    findingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', dataUnavailable: true })),
  ).toBe('Enable memory metrics');
  expect(
    findingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapNearCapacity' })),
  ).toBe('Increase executor memory');
  expect(
    findingActionLabel(finding({ type: 'memoryUtilization', variant: 'memoryBand', rule: 'heapOverProvisioned' })),
  ).toBe('Reduce executor memory');
});

test('falls back to the REGISTRY per-type label for a type with no explicit branch', () => {
  // incompleteRun never reaches this function in practice; still cover the fallback path.
  expect(findingActionLabel(finding({ type: 'incompleteRun' }))).toBe('incomplete run');
});

test('falls back to the raw type string when the type has no REGISTRY entry either', () => {
  expect(findingActionLabel(finding({ type: 'notARealDetector' }))).toBe('notARealDetector');
});
