import { describe, it, expect } from 'vitest';
import { computeWastedCoreHours } from '../src/wasted-core-hours.js';

// Round numbers keep the arithmetic exact (no float slop) so assertions are ground truth.
const app = { startTime: 0, endTime: 3_600_000 };
const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 4 }];
const runAggregates = {
  busyCoreMs: 1_800_000, // 0.5 core-hours actually ran tasks
  perStage: {
    1: { totalTaskDurationSum: 900_000 },
    2: { totalTaskDurationSum: 1_800_000 },
    3: { totalTaskDurationSum: 100_000 },
  },
};

describe('computeWastedCoreHours', () => {
  it('computes total = allocated core-time (cores x time alive) / 3.6e6 exactly', () => {
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

  it('clamps wasted at 0 when measured busy time exceeds the allocation', () => {
    // The configured core count can undercount real parallelism, so measured
    // busyCoreMs can exceed the allocation; wasted must clamp to 0, never go negative.
    const appWithRes = { ...app, config: { 'spark.executor.cores': '1' }, resources: { executor: { cores: 1 } } };
    const underCounted = [{ executorId: '1', timestamp: 0, totalCores: 0 }];
    const busierThanCapacity = { busyCoreMs: 7_200_000, perStage: {} }; // 2 core-hours busy
    const r = computeWastedCoreHours(appWithRes, underCounted, busierThanCapacity);
    expect(r.totalCoreHours).toBe(1);
    expect(r.usefulCoreHours).toBe(2);
    expect(r.wastedCoreHours).toBe(0);
  });

  it('falls back to spark.executor.cores when an executor reports no cores', () => {
    const appWithRes = { ...app, config: { 'spark.executor.cores': '2' }, resources: { executor: { cores: 2 } } };
    const noCores = [{ executorId: '1', timestamp: 0, totalCores: 0 }, { executorId: '2', timestamp: 0, totalCores: 0 }]; // 2 executors, 0 reported
    const r = computeWastedCoreHours(appWithRes, noCores, runAggregates);
    expect(r.totalCores).toBe(4); // 2 executors × 2 cores
    expect(r.totalCoreHours).toBe(4);
  });

  it('counts a replaced executor once: its cores are held for the half-hour each was alive', () => {
    // Executor a leaves at the half-hour as its same-size replacement joins: 4 cores are
    // ever concurrent although 8 were added, and 4 core-hours were allocated.
    const added = [{ executorId: 'a', timestamp: 0, totalCores: 4 }, { executorId: 'b', timestamp: 1_800_000, totalCores: 4 }];
    const removed = [{ executorId: 'a', timestamp: 1_800_000 }];
    const r = computeWastedCoreHours(app, added, runAggregates, removed);
    expect(r.totalCores).toBe(4);
    expect(r.totalCoreHours).toBe(4);
    expect(r.wastedCoreHours).toBe(3.5);
  });

  it('counts an executor only for the time it was alive, not the peak held for the whole run', () => {
    // A second executor joins at the half-hour: 8 cores at the peak, but 4 x 1h + 4 x 0.5h = 6 core-hours.
    const added = [{ executorId: 'a', timestamp: 0, totalCores: 4 }, { executorId: 'b', timestamp: 1_800_000, totalCores: 4 }];
    const r = computeWastedCoreHours(app, added, runAggregates);
    expect(r.totalCores).toBe(8);
    expect(r.totalCoreHours).toBe(6);
    expect(r.wastedCoreHours).toBe(5.5);
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
