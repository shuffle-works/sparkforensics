import { describe, it, expect } from 'vitest';
import { estimatedStageDurationAtCores, simulateScaling } from '../src/scaling-sim.js';

describe('estimatedStageDurationAtCores', () => {
  it('is total task time when cores >= task count (fully parallel)', () => {
    expect(estimatedStageDurationAtCores(1000, 10, 10)).toBe(100); // 1000/min(10,10)
    expect(estimatedStageDurationAtCores(1000, 10, 100)).toBe(100); // clamp N to taskCount
  });

  it('serializes when cores < task count', () => {
    expect(estimatedStageDurationAtCores(1000, 10, 2)).toBe(500); // 1000/2
  });

  it('is zero for a stage with no tasks', () => {
    expect(estimatedStageDurationAtCores(0, 0, 4)).toBe(0);
  });
});

describe('simulateScaling', () => {
  const app = { startTime: 0, endTime: 1000, resources: { executor: { cores: 2 } } };
  const stages = new Map([[1, { submittedAt: 0, completedAt: 1000 }]]);
  const runAggregates = { perStage: { 1: { totalTaskDurationSum: 2000, taskCount: 4 } }, busyCoreMs: 2000, peakConcurrentCores: 2 };
  const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];

  it('produces one prediction per test percentage', () => {
    const r = simulateScaling({ app, stages, runAggregates, executorsAdded });
    expect(r.predictions.length).toBe(r.testPercentages.length);
    expect(r.testPercentages).toEqual([10, 20, 50, 80, 100, 110, 120, 150, 200, 300, 400, 500]);
  });

  it('estimates a shorter makespan at more cores', () => {
    const r = simulateScaling({ app, stages, runAggregates, executorsAdded });
    const at100 = r.predictions.find(p => p.pct === 100).estMakespanMs;
    const at200 = r.predictions.find(p => p.pct === 200).estMakespanMs;
    expect(at200).toBeLessThan(at100);
  });

  it('computes a model-error percentage against observed wall-clock', () => {
    const r = simulateScaling({ app, stages, runAggregates, executorsAdded });
    expect(typeof r.modelErrorPct).toBe('number');
  });
});
