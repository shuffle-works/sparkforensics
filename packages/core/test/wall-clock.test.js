import { describe, it, expect } from 'vitest';
import { computeWallClock, mergeIntervals } from '../src/wall-clock.js';

describe('mergeIntervals', () => {
  it('merges overlapping intervals', () => {
    expect(mergeIntervals([[0, 10], [5, 15], [20, 25]])).toEqual([[0, 15], [20, 25]]);
  });
  it('handles empty input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });
  it('handles touching intervals (end == next start)', () => {
    expect(mergeIntervals([[0, 10], [10, 20]])).toEqual([[0, 20]]);
  });
});

describe('computeWallClock', () => {
  function makeStage(id, submittedAt, completedAt) {
    return { id, submittedAt, completedAt };
  }

  it('breaks an app with a single stage into startup + active + idle', () => {
    const app = { startTime: 0, endTime: 1000 };
    const stages = new Map([[1, makeStage(1, 100, 600)]]);
    const result = computeWallClock(app, stages);
    expect(result.total).toBe(1000);
    expect(result.startup).toBe(100);
    expect(result.stagesActive).toBe(500);
    expect(result.gaps).toBe(0);
    expect(result.idle).toBe(400);
  });

  it('measures gaps between stages', () => {
    const app = { startTime: 0, endTime: 1000 };
    const stages = new Map([
      [1, makeStage(1, 0, 200)],
      [2, makeStage(2, 500, 800)],
    ]);
    const result = computeWallClock(app, stages);
    expect(result.startup).toBe(0);
    expect(result.stagesActive).toBe(500);
    expect(result.gaps).toBe(300);
    expect(result.idle).toBe(200);
  });

  it('returns total = startup + stagesActive + gaps + idle (within 1ms)', () => {
    const app = { startTime: 100, endTime: 5000 };
    const stages = new Map([
      [1, makeStage(1, 200, 1000)],
      [2, makeStage(2, 1100, 3000)],
      [3, makeStage(3, 3500, 4500)],
    ]);
    const r = computeWallClock(app, stages);
    expect(Math.abs(r.total - (r.startup + r.stagesActive + r.gaps + r.idle))).toBeLessThanOrEqual(1);
  });

  it('handles empty stages', () => {
    const app = { startTime: 0, endTime: 1000 };
    const result = computeWallClock(app, new Map());
    expect(result.startup).toBe(1000);
    expect(result.stagesActive).toBe(0);
    expect(result.gaps).toBe(0);
    expect(result.idle).toBe(0);
  });
});
