import { describe, it, expect } from 'vitest';
import { runTiming } from '../src/run-timing.ts';
import { computeWallClock } from '../src/wall-clock.ts';

const stages = new Map([
  [1, { submittedAt: 1_000, completedAt: 4_000 }],
  [2, { submittedAt: 3_000, completedAt: 9_000 }],
  [3, { submittedAt: 5_000 }],
]);

describe('runTiming', () => {
  it('is complete with a finite start and an end after it', () => {
    expect(runTiming({ startTime: 0, endTime: 10_000 }, stages)).toEqual({
      complete: true, durationMs: 10_000, fallbackEndMs: 9_000, incomplete: false,
    });
  });

  it('is incomplete, with the last stage end as the fallback, when the log has a start and no end', () => {
    expect(runTiming({ startTime: 0, endTime: null }, stages)).toEqual({
      complete: false, durationMs: null, fallbackEndMs: 9_000, incomplete: true,
    });
  });

  it('is neither complete nor incomplete without an application start', () => {
    expect(runTiming(null)).toEqual({ complete: false, durationMs: null, fallbackEndMs: null, incomplete: false });
    expect(runTiming({ endTime: 5_000 })).toMatchObject({ complete: false, incomplete: false });
  });

  it('is not complete when the end does not follow the start', () => {
    expect(runTiming({ startTime: 5_000, endTime: 5_000 })).toMatchObject({ complete: false, durationMs: null, incomplete: false });
  });

  it('feeds the wall-clock span when the log has no end', () => {
    expect(computeWallClock({ startTime: 0, endTime: null }, stages).total).toBe(9_000);
    expect(computeWallClock({ startTime: 0, endTime: 12_000 }, stages).total).toBe(12_000);
  });
});
