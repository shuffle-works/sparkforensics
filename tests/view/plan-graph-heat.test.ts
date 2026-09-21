import { describe, it, expect } from 'vitest';
import { heatBand, PLAN_GRAPH_HEAT_CRIT_PCT, PLAN_GRAPH_HEAT_WARN_PCT } from '../../src/view/plan-graph/plan-graph-heat';

describe('heatBand', () => {
  it('is null when there is no duration share', () => {
    expect(heatBand(null)).toBeNull();
  });
  it('is critical at or above the critical threshold', () => {
    expect(heatBand(PLAN_GRAPH_HEAT_CRIT_PCT)).toBe('critical');
    expect(heatBand(100)).toBe('critical');
  });
  it('is warning between the warn and critical thresholds', () => {
    expect(heatBand(PLAN_GRAPH_HEAT_WARN_PCT)).toBe('warning');
    expect(heatBand(PLAN_GRAPH_HEAT_CRIT_PCT - 1)).toBe('warning');
  });
  it('is info below the warn threshold', () => {
    expect(heatBand(0)).toBe('info');
    expect(heatBand(PLAN_GRAPH_HEAT_WARN_PCT - 1)).toBe('info');
  });
});
