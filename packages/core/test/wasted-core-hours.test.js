import { describe, it, expect } from 'vitest';
import { computeWastedCoreHours } from '../src/wasted-core-hours.js';

// Round numbers keep the arithmetic exact (no float slop) so assertions are ground truth.
const app = { startTime: 0, endTime: 3_600_000 };
const executorsAdded = [{ totalCores: 4 }];
const runAggregates = {
  busyCoreMs: 1_800_000, // 0.5 core-hours actually ran tasks
  perStage: {
    1: { totalTaskDurationSum: 900_000 },
    2: { totalTaskDurationSum: 1_800_000 },
    3: { totalTaskDurationSum: 100_000 },
  },
};

describe('computeWastedCoreHours', () => {
  it('computes total = cores·dur/3.6e6 exactly', () => {
    const r = computeWastedCoreHours(app, executorsAdded, runAggregates);
    expect(r.totalCores).toBe(4);
    expect(r.totalCoreHours).toBe(4);
    expect(r.usefulCoreHours).toBe(0.5);
  });

  it('computes wasted = total − useful', () => {
    const r = computeWastedCoreHours(app, executorsAdded, runAggregates);
    expect(r.wastedCoreHours).toBe(3.5);
  });

  it('ranks top stages desc by totalTaskDurationSum', () => {
    const r = computeWastedCoreHours(app, executorsAdded, runAggregates);
    expect(r.topStages).toEqual([
      { stageId: 2, coreMs: 1_800_000 },
      { stageId: 1, coreMs: 900_000 },
      { stageId: 3, coreMs: 100_000 },
    ]);
  });

  it('caps top stages at 5', () => {
    const many = { busyCoreMs: 0, perStage: {} };
    for (let i = 0; i < 8; i++) many.perStage[i] = { totalTaskDurationSum: i * 1000 };
    const r = computeWastedCoreHours(app, executorsAdded, many);
    expect(r.topStages).toHaveLength(5);
    expect(r.topStages[0].stageId).toBe(7);
  });

  it('clamps wasted at 0 when measured busy time exceeds estimated capacity', () => {
    // The fallback capacity estimate can undercount real parallelism, so measured
    // busyCoreMs can exceed it; wasted must clamp to 0, never go negative.
    const appWithRes = { ...app, resources: { executor: { cores: 1 } } };
    const underCounted = [{ totalCores: 0 }];
    const busierThanCapacity = { busyCoreMs: 7_200_000, perStage: {} }; // 2 core-hours busy
    const r = computeWastedCoreHours(appWithRes, underCounted, busierThanCapacity);
    expect(r.totalCoreHours).toBe(1);
    expect(r.usefulCoreHours).toBe(2);
    expect(r.wastedCoreHours).toBe(0);
  });

  it('falls back to peakExecutors × executor.cores when totalCores is unavailable', () => {
    const appWithRes = { ...app, resources: { executor: { cores: 2 } } };
    const noCores = [{ totalCores: 0 }, { totalCores: 0 }]; // 2 executors, 0 reported
    const r = computeWastedCoreHours(appWithRes, noCores, runAggregates);
    expect(r.totalCores).toBe(4); // 2 executors × 2 cores
    expect(r.totalCoreHours).toBe(4);
  });

  it('returns nulls/empties without throwing when runAggregates is missing', () => {
    const r = computeWastedCoreHours(app, executorsAdded, null);
    expect(r).toEqual({
      totalCoreHours: null,
      usefulCoreHours: null,
      wastedCoreHours: null,
      totalCores: null,
      topStages: [],
    });
  });

  it('returns nulls/empties when no core count can be derived', () => {
    const r = computeWastedCoreHours(app, [{ totalCores: 0 }], runAggregates);
    expect(r.totalCoreHours).toBeNull();
    expect(r.topStages).toEqual([]);
  });

  it('returns nulls/empties when app times are missing (nullish, not falsy: startTime:0 is valid)', () => {
    expect(computeWastedCoreHours({ endTime: 1 }, executorsAdded, runAggregates).totalCoreHours).toBeNull();
    // startTime:0 must NOT be treated as missing.
    const r = computeWastedCoreHours({ startTime: 0, endTime: 3_600_000 }, executorsAdded, runAggregates);
    expect(r.totalCoreHours).toBe(4);
  });

  it('does not throw when app is null', () => {
    expect(() => computeWastedCoreHours(null, executorsAdded, runAggregates)).not.toThrow();
    expect(computeWastedCoreHours(null, executorsAdded, runAggregates).totalCoreHours).toBeNull();
  });
});
