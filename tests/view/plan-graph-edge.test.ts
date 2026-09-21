import { test, expect } from 'vitest';
import {
  exchangeEdgeStrokeWidth,
  exchangeEdgeOpacity,
  EXCHANGE_EDGE_MIN_WIDTH,
  EXCHANGE_EDGE_MAX_WIDTH,
  EXCHANGE_EDGE_MIN_OPACITY,
  EXCHANGE_EDGE_MAX_OPACITY,
} from '@/view/plan-graph/plan-graph-edge';

test('the heaviest exchange gets the max stroke width and opacity', () => {
  expect(exchangeEdgeStrokeWidth(1_000_000, 1_000_000)).toBeCloseTo(EXCHANGE_EDGE_MAX_WIDTH);
  expect(exchangeEdgeOpacity(1_000_000, 1_000_000)).toBeCloseTo(EXCHANGE_EDGE_MAX_OPACITY);
});

test('a tiny exchange sits near the floor but stays above the minimum', () => {
  const width = exchangeEdgeStrokeWidth(1, 1_000_000);
  expect(width).toBeGreaterThanOrEqual(EXCHANGE_EDGE_MIN_WIDTH);
  expect(width).toBeLessThan(EXCHANGE_EDGE_MAX_WIDTH / 2);
});

test('a zero or missing max falls back to the minimum, never NaN', () => {
  expect(exchangeEdgeStrokeWidth(0, 0)).toBe(EXCHANGE_EDGE_MIN_WIDTH);
  expect(exchangeEdgeStrokeWidth(4096, 0)).toBe(EXCHANGE_EDGE_MIN_WIDTH);
  expect(exchangeEdgeOpacity(0, 0)).toBe(EXCHANGE_EDGE_MIN_OPACITY);
});

test('the log scale keeps a mid-magnitude exchange visibly between floor and ceiling', () => {
  // 1000 against a 1e6 max: linear would be 0.1% (invisible); log lifts it well
  // clear of the floor so a moderate shuffle still reads as moderate.
  const width = exchangeEdgeStrokeWidth(1000, 1_000_000);
  expect(width).toBeGreaterThan(EXCHANGE_EDGE_MIN_WIDTH + 1);
  expect(width).toBeLessThan(EXCHANGE_EDGE_MAX_WIDTH);
});
