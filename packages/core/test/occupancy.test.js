import { describe, it, expect } from 'vitest';
import { computeOccupancyMs, computeGate, computeCeiling, clipToCeiling, computeOccupancy, estimateSingleStage, estimateMultiStage, tailRemovedWorkMs } from '../src/occupancy.js';
import { mergeIntervals } from '../src/wall-clock.js';

function stage(id, opts) {
  return { id, submittedAt: 0, completedAt: 0, ...opts };
}

describe('computeOccupancyMs', () => {
  it('gives a solo stage its full duration as occupancy, even with no executorRunTime data', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 5000 })]]);
    expect(computeOccupancyMs(stages).get(0)).toBe(5000);
  });

  it('splits a fully-overlapping pair 50/50 when their coreWeights are equal', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000, executorRunTime: 500 })],
      [1, stage(1, { submittedAt: 0, completedAt: 1000, executorRunTime: 500 })],
    ]);
    const occ = computeOccupancyMs(stages);
    expect(occ.get(0)).toBe(500);
    expect(occ.get(1)).toBe(500);
  });

  it('splits a fully-overlapping pair proportional to coreWeight when they differ', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000, executorRunTime: 750 })], // weight .75
      [1, stage(1, { submittedAt: 0, completedAt: 1000, executorRunTime: 250 })], // weight .25
    ]);
    const occ = computeOccupancyMs(stages);
    expect(occ.get(0)).toBe(750);
    expect(occ.get(1)).toBe(250);
  });

  it('falls back to an equal split when every active stage has coreWeight 0, so a solo zero-weight stage still gets its whole span (not 0)', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000 })], // no executorRunTime -> weight 0
      [1, stage(1, { submittedAt: 0, completedAt: 1000 })], // no executorRunTime -> weight 0
    ]);
    const occ = computeOccupancyMs(stages);
    expect(occ.get(0)).toBe(500);
    expect(occ.get(1)).toBe(500);
  });

  it('excludes a zero-duration stage from the sweep entirely: no key in the result', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000 })],
      [1, stage(1, { submittedAt: 5000, completedAt: 5000 })], // Spark-skipped-stage shape
    ]);
    const occ = computeOccupancyMs(stages);
    expect(occ.has(1)).toBe(false);
    expect(occ.size).toBe(1);
  });

  it('conservation identity: total occupancy across all stages equals the merged stage-active-time union of the run, for any weight mix', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000 })], // solo, weight 0
      [1, stage(1, { submittedAt: 1000, completedAt: 4000, executorRunTime: 1500 })], // weight .5
      [2, stage(2, { submittedAt: 2000, completedAt: 3000, executorRunTime: 250 })], // weight .25, nested inside 1
      [3, stage(3, { submittedAt: 5000, completedAt: 5000 })], // excluded (zero duration)
      [4, stage(4, { submittedAt: 5000, completedAt: 6000 })], // separate, after a gap
    ]);
    const occ = computeOccupancyMs(stages);
    const totalOccupancy = [...occ.values()].reduce((a, b) => a + b, 0);
    const union = mergeIntervals([[0, 1000], [1000, 4000], [2000, 3000], [5000, 6000]])
      .reduce((sum, [a, b]) => sum + (b - a), 0);
    expect(totalOccupancy).toBeCloseTo(union, 6);
    expect(union).toBe(5000); // [0,4000] merged + [5000,6000]
  });
});

describe('computeGate', () => {
  it('gives a solo stage gate 1.0', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 5000 })]]);
    expect(computeGate(stages).get(0)).toBe(1);
  });

  it('gives two fully-overlapping equal-weight stages gate 0.5 each', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 1000, executorRunTime: 500 })],
      [1, stage(1, { submittedAt: 0, completedAt: 1000, executorRunTime: 500 })],
    ]);
    const gate = computeGate(stages);
    expect(gate.get(0)).toBe(0.5);
    expect(gate.get(1)).toBe(0.5);
  });

  it('has no entry for a zero-duration stage', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 5000, completedAt: 5000 })]]);
    expect(computeGate(stages).has(0)).toBe(false);
  });
});

describe('computeCeiling', () => {
  it('uses taskDurationMax alone when totalCores is unknown (<= 0)', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 4200, executorRunTime: 90000 });
    expect(computeCeiling(s, 0)).toBe(4200);
  });

  it('uses coreWork/totalCores when it exceeds taskDurationMax', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 100, executorRunTime: 40000 });
    // coreWork/totalCores = 40000/4 = 10000, which dominates taskDurationMax (100)
    expect(computeCeiling(s, 4)).toBe(10000);
  });

  it('uses taskDurationMax when it exceeds coreWork/totalCores', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 8000, executorRunTime: 4000 });
    // coreWork/totalCores = 4000/4 = 1000, dominated by taskDurationMax (8000)
    expect(computeCeiling(s, 4)).toBe(8000);
  });
});

describe('clipToCeiling', () => {
  it('caps a waste claim at the stage duration minus its ceiling (reproduces the spec\'s cited tinyTask overclaim fix: 407.5s claim on a 13.1s stage capped to 8.9s)', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 13100, taskDurationMax: 4200 });
    const ceiling = computeCeiling(s, 0); // 4200
    expect(clipToCeiling(407500, s, ceiling)).toBe(8900);
  });

  it('leaves a claim unchanged when it fits within the stage\'s recoverable room', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 1000 });
    const ceiling = computeCeiling(s, 0); // 1000, room = 9000
    expect(clipToCeiling(500, s, ceiling)).toBe(500);
  });

  it('never returns a negative room even when ceiling exceeds duration', () => {
    const s = stage(0, { submittedAt: 0, completedAt: 1000, taskDurationMax: 5000 });
    const ceiling = computeCeiling(s, 0); // 5000, room = max(0, 1000-5000) = 0
    expect(clipToCeiling(9999, s, ceiling)).toBe(0);
  });
});

describe('computeOccupancy', () => {
  it('merges gate and ceiling per stage, omitting excluded stages', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 5000, taskDurationMax: 1000 })],
      [1, stage(1, { submittedAt: 5000, completedAt: 5000 })], // excluded
    ]);
    const info = computeOccupancy(stages, 0);
    expect(info.get(0)).toEqual({ gate: 1, ceiling: 1000, coreWorkFloor: 0 });
    expect(info.has(1)).toBe(false);
  });
});

describe('estimateSingleStage', () => {
  it('serial basis: gate >= 0.999 gives a point estimate at the clipped value', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 5000 })]]);
    const info = computeOccupancy(stages, 0);
    const est = estimateSingleStage(1200, 0, stages, info);
    expect(est).toEqual({ basis: 'serial', wallClock: { low: 1200, high: 1200 } });
  });

  it('contended basis: gate < 0.999 gives high = clipped, low = clipped * gate', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 3000 })],
      [1, stage(1, { submittedAt: 0, completedAt: 3000 })], // fully overlapping, equal weight -> gate 0.5 each
    ]);
    const info = computeOccupancy(stages, 0);
    const est = estimateSingleStage(1200, 0, stages, info);
    expect(est.basis).toBe('contended');
    expect(est.wallClock.high).toBe(1200);
    expect(est.wallClock.low).toBe(600);
  });

  it('applies the ceiling clip before gate-weighting', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 9000 })]]);
    const info = computeOccupancy(stages, 0); // ceiling 9000, room 1000, gate 1 (solo)
    const est = estimateSingleStage(3000, 0, stages, info);
    expect(est).toEqual({ basis: 'serial', wallClock: { low: 1000, high: 1000 } });
  });

  it('shortensLongestTask: floors a tail claim at the longest task the fix leaves, not at the current one', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 9500 })]]);
    const info = computeOccupancy(stages, 0);
    // Plain clip: ceiling 9500 leaves 500ms. Tail claim of 9000: post-fix longest task 500, room 9500.
    expect(estimateSingleStage(9000, 0, stages, info).wallClock.high).toBe(500);
    expect(estimateSingleStage(9000, 0, stages, info, { shortensLongestTask: true }).wallClock.high).toBe(9000);
  });

  it('shortensLongestTask: the core-work floor (executorRunTime / totalCores) still applies', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 9500, executorRunTime: 32000 })]]);
    const info = computeOccupancy(stages, 4); // coreWorkFloor 8000: room 2000
    expect(info.get(0).coreWorkFloor).toBe(8000);
    expect(estimateSingleStage(9000, 0, stages, info, { shortensLongestTask: true }).wallClock.high).toBe(2000);
  });

  it('shortensLongestTask: the core-work floor counts only the work the fix leaves', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 0, completedAt: 10000, taskDurationMax: 9500, executorRunTime: 32000 })]]);
    const info = computeOccupancy(stages, 4);
    // Removing 16000 of the 32000ms of task time halves the floor to 4000: room 6000.
    const est = estimateSingleStage(9000, 0, stages, info, { shortensLongestTask: true, removedCoreWorkMs: 16000 });
    expect(est.wallClock.high).toBe(6000);
    expect(tailRemovedWorkMs({ stragglerExcessMs: 16000 }, 9000)).toBe(16000);
    expect(tailRemovedWorkMs({ stragglerExcessMs: 0 }, 9000)).toBe(9000);
  });

  it('returns null for a stage excluded from the sweep', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 5000, completedAt: 5000 })]]);
    const info = computeOccupancy(stages, 0);
    expect(estimateSingleStage(100, 0, stages, info)).toBeNull();
  });
});

describe('estimateMultiStage', () => {
  it('sums non-overlapping stages\' estimates without a union cap kicking in', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 100000 })],
      [1, stage(1, { submittedAt: 100000, completedAt: 200000 })],
    ]);
    const info = computeOccupancy(stages, 0);
    const waste = new Map([[0, 75000], [1, 75000]]);
    const est = estimateMultiStage([0, 1], waste, stages, info);
    expect(est).toEqual({ basis: 'serial', wallClock: { low: 150000, high: 150000 } });
  });

  it('caps the joint claim at the union of the finding\'s own stage windows when they overlap', () => {
    const stages = new Map([
      [0, stage(0, { submittedAt: 0, completedAt: 9000 })], // fully overlaps stage 1 -> gate 0.5
      [1, stage(1, { submittedAt: 0, completedAt: 9000 })], // fully overlaps stage 0 -> gate 0.5
    ]);
    const info = computeOccupancy(stages, 0);
    // Both claim their own full 9000ms duration as waste: naive sum would be 18000,
    // but the two stages' windows are identical, so the union is only 9000ms.
    const waste = new Map([[0, 9000], [1, 9000]]);
    const est = estimateMultiStage([0, 1], waste, stages, info);
    expect(est.wallClock.high).toBe(9000); // capped, not 9000 (stage0) + 9000 (stage1)
    expect(est.wallClock.high).toBeLessThan(9000 + 4500); // proves the cap, not naive summing
    // The union cap forces low === high numerically, but both stages are individually
    // contended (gate 0.5): basis must reflect that, not the numeric coincidence.
    expect(est.basis).toBe('contended');
  });

  it('returns null when every one of the finding\'s stages was excluded from the sweep', () => {
    const stages = new Map([[0, stage(0, { submittedAt: 5000, completedAt: 5000 })]]);
    const info = computeOccupancy(stages, 0);
    expect(estimateMultiStage([0], new Map([[0, 100]]), stages, info)).toBeNull();
  });
});
