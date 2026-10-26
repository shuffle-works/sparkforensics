import { describe, it, expect } from 'vitest';
import { estimatedStageDurationAtCores, simulateScaling, smallestCoresWithinTolerance } from '../src/scaling-sim.js';

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
  // The one stage ran 0-1000ms, so stages were active for the whole run.
  const observedActiveMs = 1000;
  const runAggregates = { perStage: { 1: { totalTaskDurationSum: 2000, taskCount: 4 } }, busyCoreMs: 2000, peakConcurrentCores: 2 };
  const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];

  it('produces one prediction per test percentage', () => {
    const r = simulateScaling({ app, observedActiveMs, runAggregates, executorsAdded });
    expect(r.predictions.length).toBe(r.testPercentages.length);
    expect(r.testPercentages).toEqual([10, 20, 50, 80, 100, 110, 120, 150, 200, 300, 400, 500]);
  });

  it('estimates a shorter makespan at more cores', () => {
    const r = simulateScaling({ app, observedActiveMs, runAggregates, executorsAdded });
    const at100 = r.predictions.find(p => p.pct === 100).estMakespanMs;
    const at200 = r.predictions.find(p => p.pct === 200).estMakespanMs;
    expect(at200).toBeLessThan(at100);
  });

  it('computes a model-error percentage against observed wall-clock', () => {
    const r = simulateScaling({ app, observedActiveMs, runAggregates, executorsAdded });
    expect(typeof r.modelErrorPct).toBe('number');
  });
});

describe('smallestCoresWithinTolerance', () => {
  // One stage of 8 tasks, 10 s of work per core at 8 cores: more than 8 cores buys nothing.
  const perStage = { 1: { totalTaskDurationSum: 80000, taskCount: 8 } };
  const fit = (overrides) => smallestCoresWithinTolerance({
    perStage, baselineCores: 16, observedActiveMs: 10000, tolerancePct: 10, ...overrides,
  });

  it('finds the core count past which the stage cannot use more cores', () => {
    expect(fit()).toEqual({ cores: 8, estMakespanMs: 10000, modelErrorPct: 0 });
  });

  it('allows fewer cores as the tolerance grows', () => {
    // 80000/7 = 11429 ms is 14% over 10 s, 80000/6 = 13333 ms is 33% over.
    expect(fit({ tolerancePct: 0 }).cores).toBe(8);
    expect(fit({ tolerancePct: 15 }).cores).toBe(7);
    expect(fit({ tolerancePct: 40 }).cores).toBe(6);
  });

  it('keeps the baseline when every core is in use', () => {
    const busy = { 1: { totalTaskDurationSum: 160000, taskCount: 64 } };
    expect(fit({ perStage: busy, observedActiveMs: 10000, tolerancePct: 0 }).cores).toBe(16);
  });

  it('reports the model error against the observed makespan', () => {
    expect(fit({ observedActiveMs: 20000 }).modelErrorPct).toBe(50);
  });

  it('returns null with nothing to model', () => {
    expect(fit({ perStage: {} })).toBeNull();
    expect(fit({ baselineCores: 0 })).toBeNull();
    expect(fit({ observedActiveMs: 0 })).toBeNull();
  });
});
