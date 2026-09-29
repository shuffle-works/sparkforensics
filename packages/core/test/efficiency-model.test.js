import { describe, it, expect } from 'vitest';
import { computeEfficiencyModel } from '../src/efficiency-model.js';

describe('computeEfficiencyModel', () => {
  const app = { startTime: 0, endTime: 3600000, resources: { executor: { cores: 1 } } }; // 1 hour
  const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];

  it('splits available compute-hours into driver and executor waste', () => {
    // stagesActive 1800000ms (0.5h), so startup+gaps+idle = 0.5h driver-bound.
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 1800000 }]]);
    const runAggregates = { busyCoreMs: 1800000, perStage: { 1: { totalTaskDurationSum: 1800000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded, executorsRemoved: [], runAggregates });
    expect(r.availableComputeHours).toBeCloseTo(2 * 1, 5); // 2 cores * 1h
    expect(r.driverWasteHours).toBeGreaterThan(0);
    expect(r.executorWasteHours).toBeGreaterThanOrEqual(0);
    expect(['driver', 'executor', null]).toContain(r.dominantWaste);
  });

  it('reports the zero-skew theoretical floor', () => {
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 1800000 }]]);
    const runAggregates = { busyCoreMs: 1800000, perStage: { 1: { totalTaskDurationSum: 3600000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded, executorsRemoved: [], runAggregates });
    expect(r.floorZeroSkewMs).toBe(3600000 / 2);  // total task time / total cores
  });

  it('counts a replaced executor once: capacity is peak concurrent cores, not every addition', () => {
    // Executor 1 leaves at the half-hour as its same-size replacement joins, so 2 cores are
    // ever concurrent although 4 were added. One core busy for the whole hour leaves half idle.
    const churned = [...executorsAdded, { executorId: '2', timestamp: 1800000, totalCores: 2 }];
    const removed = [{ executorId: '1', timestamp: 1800000 }];
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 3600000 }]]);
    const runAggregates = { busyCoreMs: 3600000, perStage: { 1: { totalTaskDurationSum: 3600000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded: churned, executorsRemoved: removed, runAggregates });
    expect(r.availableComputeHours).toBeCloseTo(2, 5);
    expect(r.wastagePct).toBe(50);
  });
});
