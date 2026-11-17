import { describe, it, expect } from 'vitest';
import { coreLocalityDetector } from '../src/detectors/core-locality/detect.ts';

const thresholds = coreLocalityDetector.thresholds;

/**
 * One stage of `taskCount` tasks, `nonLocal` of them ANY, with `runTimeMs` of task time.
 * @param {{ taskCount: number, nonLocal: number, runTimeMs: number }} spec
 */
function ctxFor({ taskCount, nonLocal, runTimeMs }) {
  const stage = {
    id: 1, taskCount, executorRunTime: runTimeMs,
    localityStats: [
      { locality: 'PROCESS_LOCAL', count: taskCount - nonLocal },
      { locality: 'ANY', count: nonLocal },
    ],
  };
  return { app: {}, stages: new Map([[1, stage]]), executorsAdded: [] };
}

/** @param {{ taskCount: number, nonLocal: number, runTimeMs: number }} spec */
const bandOf = (spec) => {
  const detect = /** @type {(ctx: unknown, thresholds: unknown) => { impactBand: string } | null} */ (coreLocalityDetector.detect);
  return detect(ctxFor(spec), thresholds)?.impactBand;
};

describe('coreLocality band', () => {
  it('is not critical for a high non-local ratio with a negligible modeled cost', () => {
    // 60% of 100 tasks non-local: 60 * 20 ms = 1.2 core-s of a 1,000 core-s run (0.12%).
    expect(bandOf({ taskCount: 100, nonLocal: 60, runTimeMs: 1_000_000 })).toBe('info');
  });

  it('is critical when the ratio is high and the modeled cost reaches the critical share of task time', () => {
    // 6,000 * 20 ms = 120 core-s of 1,000 core-s (12%).
    expect(bandOf({ taskCount: 10_000, nonLocal: 6_000, runTimeMs: 1_000_000 })).toBe('critical');
  });

  it('is a warning when the cost is between the warning and critical shares', () => {
    // 600 * 20 ms = 12 core-s of 1,000 core-s (1.2%).
    expect(bandOf({ taskCount: 1_000, nonLocal: 600, runTimeMs: 1_000_000 })).toBe('warning');
  });

  it('keeps a high cost share a warning below the critical ratio', () => {
    // 20% non-local: under critRatio, so a costly run still stays a warning.
    expect(bandOf({ taskCount: 100_000, nonLocal: 20_000, runTimeMs: 1_000_000 })).toBe('warning');
  });

  it('is a warning when the run records no task time to compare the cost with', () => {
    expect(bandOf({ taskCount: 100, nonLocal: 60, runTimeMs: 0 })).toBe('warning');
  });
});
