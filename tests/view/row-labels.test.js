import { test, expect } from 'vitest';
import { formatStageIdsLabel } from '../../src/view/row-labels';

test('formatStageIdsLabel prints every id when within the default cap', () => {
  expect(formatStageIdsLabel([1, 2, 3])).toBe('1, 2, 3');
});
test('formatStageIdsLabel truncates past the default cap and counts the remainder', () => {
  const ids = Array.from({ length: 10 }, (_, i) => i + 1);
  expect(formatStageIdsLabel(ids)).toBe('1, 2, 3, 4, 5, 6, 7, 8, +2 more');
});
test('formatStageIdsLabel honors a custom cap', () => {
  expect(formatStageIdsLabel([1, 2, 3, 4], 2)).toBe('1, 2, +2 more');
});
