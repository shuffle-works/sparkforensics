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
