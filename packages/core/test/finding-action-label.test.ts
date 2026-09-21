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
