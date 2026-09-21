import { describe, it, expect } from 'vitest';
import { computeTotalCores, computePeakConcurrentCores, computePeakConcurrentExecutorCount } from '../src/core-count.js';

describe('computeTotalCores', () => {
  it('sums real totalCores from executorsAdded when present', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [
      { executorId: '1', totalCores: 2 },
      { executorId: '2', totalCores: 3 },
      { executorId: '3', totalCores: 2 },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(7);
  });

  it('falls back to peakExecutors × configured cores when real totalCores is missing or zero', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [
      { executorId: '1' },
      { executorId: '2' },
      { executorId: '3' },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(12);
  });

  it('handles mixed totalCores and fallback when sum is zero', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [
      { executorId: '1', totalCores: 0 },
      { executorId: '2', totalCores: null },
      { executorId: '3' },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(12);
  });

  it('returns 0 when cores config is missing and totalCores is zero', () => {
    const app = { resources: { executor: {} } };
    const executorsAdded = [
      { executorId: '1' },
      { executorId: '2' },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(0);
  });

  it('returns 0 when app has no resources config', () => {
    const app = {};
    const executorsAdded = [
      { executorId: '1' },
      { executorId: '2' },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(0);
  });

  it('returns 0 when executorsAdded is empty', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [];
    expect(computeTotalCores(app, executorsAdded)).toBe(0);
  });

  it('returns 0 when both totalCores and cores are missing/zero', () => {
    const app = { resources: {} };
    const executorsAdded = [{ executorId: '1', totalCores: 0 }];
    expect(computeTotalCores(app, executorsAdded)).toBe(0);
  });

  it('handles partial totalCores (some executors have real, others missing)', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [
      { executorId: '1', totalCores: 5 },
      { executorId: '2' },
    ];
    expect(computeTotalCores(app, executorsAdded)).toBe(5);
  });
});

describe('computePeakConcurrentCores', () => {
  it('sums concurrently-alive executors, not the cumulative sum of every addition', () => {
    const app = { resources: { executor: { cores: 2 } } };
    // Executors replace each other in sequence, so at most one 2-core executor
    // is alive at once; computeTotalCores would sum all three additions (6).
    const executorsAdded = [
      { executorId: '1', timestamp: 0, totalCores: 2 },
      { executorId: '2', timestamp: 1000, totalCores: 2 },
      { executorId: '3', timestamp: 2000, totalCores: 2 },
    ];
    const executorsRemoved = [
      { executorId: '1', timestamp: 1000 },
      { executorId: '2', timestamp: 2000 },
    ];
    expect(computePeakConcurrentCores(app, executorsAdded, executorsRemoved)).toBe(2);
  });

  it('reflects genuine concurrent overlap when executors overlap in time', () => {
    const app = { resources: { executor: { cores: 2 } } };
    // exec 2 joins before exec 1 leaves, so both are alive at once: peak is 4.
    const executorsAdded = [
      { executorId: '1', timestamp: 0, totalCores: 2 },
      { executorId: '2', timestamp: 500, totalCores: 2 },
    ];
    const executorsRemoved = [
      { executorId: '1', timestamp: 1000 },
    ];
    expect(computePeakConcurrentCores(app, executorsAdded, executorsRemoved)).toBe(4);
  });

  it('falls back to peakExecutors × configured cores when no real totalCores data exists', () => {
    const app = { resources: { executor: { cores: 4 } } };
    const executorsAdded = [
      { executorId: '1', timestamp: 0 },
      { executorId: '2', timestamp: 0 },
    ];
    expect(computePeakConcurrentCores(app, executorsAdded, [])).toBe(8);
  });

  it('returns 0 when executorsAdded is empty and no fallback cores exist', () => {
    const app = {};
    expect(computePeakConcurrentCores(app, [], [])).toBe(0);
  });

  it('fallback stays concurrency-aware under churn when totalCores is missing', () => {
    const app = { resources: { executor: { cores: 4 } } };
    // Executors replace each other one at a time and none carry totalCores, so
    // the sweep is 0 and the fallback kicks in; length * cores (12) would
    // overcount the real peak concurrency of 1.
    const executorsAdded = [
      { executorId: '1', timestamp: 0 },
      { executorId: '2', timestamp: 1000 },
      { executorId: '3', timestamp: 2000 },
    ];
    const executorsRemoved = [
      { executorId: '1', timestamp: 1000 },
      { executorId: '2', timestamp: 2000 },
    ];
    expect(computePeakConcurrentCores(app, executorsAdded, executorsRemoved)).toBe(4);
  });
});

describe('computePeakConcurrentExecutorCount', () => {
  it('counts concurrently-alive executors, not the total ever added', () => {
    // 5 executors added over the run, but replaced one at a time so at most 2 are alive at once.
    const executorsAdded = [
      { executorId: 'a', timestamp: 0 },
      { executorId: 'b', timestamp: 0 },
      { executorId: 'c', timestamp: 25000 },
      { executorId: 'd', timestamp: 50000 },
      { executorId: 'e', timestamp: 75000 },
    ];
    const executorsRemoved = [
      { executorId: 'a', timestamp: 25000 },
      { executorId: 'b', timestamp: 50000 },
      { executorId: 'c', timestamp: 75000 },
    ];
    expect(computePeakConcurrentExecutorCount(executorsAdded, executorsRemoved)).toBe(2);
  });

  it('reflects genuine concurrent overlap when executors overlap in time', () => {
    const executorsAdded = [
      { executorId: '1', timestamp: 0 },
      { executorId: '2', timestamp: 500 },
    ];
    const executorsRemoved = [{ executorId: '1', timestamp: 1000 }];
    expect(computePeakConcurrentExecutorCount(executorsAdded, executorsRemoved)).toBe(2);
  });

  it('returns 0 when executorsAdded is empty', () => {
    expect(computePeakConcurrentExecutorCount([], [])).toBe(0);
  });
});
