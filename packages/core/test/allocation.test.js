import { describe, it, expect } from 'vitest';
import { computeAllocation } from '../src/allocation.ts';
import { makeApp } from './fixtures/stage-app-fixtures.js';

const HOUR = 3_600_000;
// One 1-core executor alive for one hour, so memoryGbHours is the container size in GiB.
function gbHours(config) {
  const input = {
    app: makeApp({ endTime: HOUR, config }),
    stages: new Map(),
    executors: { added: [{ kind: 'added', executorId: '1', timestamp: 0, totalCores: 1 }], removed: [] },
  };
  return computeAllocation(input).memoryGbHours;
}

describe('computeAllocation memory', () => {
  it('uses Spark defaults when keys are absent: 1g heap plus max(384 MiB, 10%)', () => {
    expect(gbHours({})).toBeCloseTo((1024 + 384) / 1024, 10);
  });

  it('adds the default 10% overhead for a larger heap', () => {
    expect(gbHours({ 'spark.executor.memory': '10g' })).toBeCloseTo((10240 + 1024) / 1024, 10);
  });

  it('honors spark.executor.memoryOverheadFactor', () => {
    expect(gbHours({ 'spark.executor.memory': '10g', 'spark.executor.memoryOverheadFactor': '0.4' })).toBeCloseTo((10240 + 4096) / 1024, 10);
  });

  it('prefers spark.executor.memoryOverhead over the legacy yarn key, and reads the legacy key alone', () => {
    const base = { 'spark.executor.memory': '4g' };
    expect(gbHours({ ...base, 'spark.executor.memoryOverhead': '1g', 'spark.yarn.executor.memoryOverhead': '2g' })).toBeCloseTo(5, 10);
    expect(gbHours({ ...base, 'spark.yarn.executor.memoryOverhead': '2g' })).toBeCloseTo(6, 10);
  });

  it('adds off-heap memory only when off-heap is enabled', () => {
    const base = { 'spark.executor.memory': '4g', 'spark.executor.memoryOverhead': '1g', 'spark.memory.offHeap.size': '2g' };
    expect(gbHours(base)).toBeCloseTo(5, 10);
    expect(gbHours({ ...base, 'spark.memory.offHeap.enabled': 'true' })).toBeCloseTo(7, 10);
  });

  it('adds spark.executor.pyspark.memory', () => {
    expect(gbHours({ 'spark.executor.memory': '4g', 'spark.executor.memoryOverhead': '1g', 'spark.executor.pyspark.memory': '512m' })).toBeCloseTo(5.5, 10);
  });

  it('is null, not a guess, when a memory key is unreadable or the log has no Spark properties', () => {
    expect(gbHours({ 'spark.executor.memory': 'lots' })).toBeNull();
    expect(gbHours({ 'spark.executor.memoryOverhead': '??' })).toBeNull();
    expect(gbHours(undefined)).toBeNull();
  });
});

describe('computeAllocation executors', () => {
  const added = (executorId, timestamp, totalCores = 2) => ({ kind: 'added', executorId, timestamp, totalCores });
  const removed = (executorId, timestamp) => ({ kind: 'removed', executorId, timestamp });
  const allocate = (config, executors, app = {}) =>
    computeAllocation({ app: makeApp({ startTime: 0, endTime: HOUR, config, ...app }), stages: new Map(), executors });

  it('reports peak, mean and seconds over executors that churn', () => {
    // e1 alive 0-1800 s, e2 alive 900 s to the 3600 s end, e3 replaces e1 at 1800 s: 2 live at the peak.
    const a = allocate({}, { added: [added('1', 0), added('2', 900_000), added('3', 1_800_000)], removed: [removed('1', 1_800_000)] });
    expect(a.executorsPeak).toBe(2);
    expect(a.executorSeconds).toBe(1800 + 2700 + 1800);
    expect(a.executorsMean).toBeCloseTo(6300 / 3600, 10);
    expect(a.executorCores).toBe(2);
  });

  it('counts a replayed or orphan ExecutorRemoved once so the peak matches the alive intervals', () => {
    const a = allocate({}, {
      added: [added('1', 0), added('2', 2000), added('3', 3000)],
      removed: [removed('1', 1000), removed('1', 1500), removed('9', 1200)],
    });
    expect(a.executorsPeak).toBe(2);
  });

  it('counts a replayed ExecutorAdded once', () => {
    const a = allocate({}, { added: [added('1', 0), added('1', 0)], removed: [] });
    expect(a.executorsPeak).toBe(1);
    expect(a.executorSeconds).toBe(3600);
  });

  it('measures the mean over the window from application start, not from the first executor', () => {
    const a = allocate({}, { added: [added('1', 1_800_000)], removed: [] });
    expect(a.executorsMean).toBeCloseTo(0.5, 10);
  });

  it('has no executor cores when they differ or are unknown, and no mean without an application start', () => {
    expect(allocate({}, { added: [added('1', 0, 2), added('2', 0, 4)], removed: [] }).executorCores).toBeNull();
    expect(allocate({}, { added: [added('1', 0, 0)], removed: [] }).executorCores).toBeNull();
    const noStart = allocate({}, { added: [added('1', 0)], removed: [] }, { startTime: undefined });
    expect(noStart.executorsMean).toBeNull();
    expect(noStart.executorSeconds).toBe(3600);
  });

  it('is null across the executor figures when the log has no executor events', () => {
    const a = allocate({}, { added: [], removed: [] });
    expect(a).toMatchObject({ executorsPeak: null, executorsMean: null, executorCores: null, executorSeconds: null });
  });

  it('reads dynamic allocation as on or off only when the log records it', () => {
    const executors = { added: [added('1', 0)], removed: [] };
    expect(allocate({ 'spark.dynamicAllocation.enabled': 'true' }, executors).dynamicAllocation).toBe('on');
    expect(allocate({ 'spark.dynamicAllocation.enabled': ' FALSE ' }, executors).dynamicAllocation).toBe('off');
    expect(allocate({}, executors).dynamicAllocation).toBeNull();
    expect(allocate(undefined, { added: [], removed: [] }).dynamicAllocation).toBeNull();
  });
});
