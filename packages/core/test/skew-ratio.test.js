import { describe, it, expect } from 'vitest';
import { computeSkewRatio } from '../src/detectors.js';

describe('computeSkewRatio', () => {
  it('returns null when the stage has no measurable median (p50 === 0)', () => {
    const stage = { taskCount: 100, taskDurationP50: 0, taskDurationP95: 500, taskDurationMax: 900 };
    expect(computeSkewRatio(stage, 20)).toBeNull();
  });

  it('uses P95/median once taskCount reaches minTasksForP95', () => {
    const stage = { taskCount: 20, taskDurationP50: 100, taskDurationP95: 400, taskDurationMax: 900 };
    expect(computeSkewRatio(stage, 20)).toEqual({ ratio: 4, metric: 'P95/median' });
  });

  it('falls back to max/median when taskCount is below minTasksForP95', () => {
    const stage = { taskCount: 19, taskDurationP50: 100, taskDurationP95: 400, taskDurationMax: 900 };
    expect(computeSkewRatio(stage, 20)).toEqual({ ratio: 9, metric: 'max/median' });
  });
});
