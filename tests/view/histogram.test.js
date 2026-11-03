import { test, expect } from 'vitest';
import { buildHistogram } from '../../src/view/charts/histogram';

test('buildHistogram bins values', () => {
  const h = buildHistogram([1, 2, 3, 4], 2);
  expect(h.data.reduce((a, b) => a + b, 0)).toBe(4);
});
test('buildHistogram returns empty labels/data for an empty input', () => {
  expect(buildHistogram([], 4)).toEqual({ labels: [], data: [] });
});
