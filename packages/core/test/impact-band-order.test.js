import { test, expect } from 'vitest';
import { worstImpactBand } from '../src/impact-band-order.js';

test('worstImpactBand returns undefined on an empty list', () => {
  expect(worstImpactBand([])).toBeUndefined();
});
test('worstImpactBand picks the lowest-IMPACT_BAND_ORDER impact band, ties broken by first occurrence', () => {
  expect(
    worstImpactBand([{ impactBand: 'info' }, { impactBand: 'critical' }, { impactBand: 'warning' }]),
  ).toBe('critical');
  expect(worstImpactBand([{ impactBand: 'warning' }, { impactBand: 'warning' }])).toBe('warning');
});
