import { describe, it, expect } from 'vitest';
import { computeEfficiencyModel } from '../src/efficiency-model.js';

describe('computeEfficiencyModel', () => {
  const app = { startTime: 0, endTime: 3600000, resources: { executor: { cores: 1 } } }; // 1 hour
  const executorsAdded = [{ executorId: '1', timestamp: 0, totalCores: 2 }];

  it('splits available compute-hours into driver and executor waste', () => {
    // stagesActive 1800000ms (0.5h), so startup+gaps+idle = 0.5h driver-bound.
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 1800000 }]]);
    const runAggregates = { busyCoreMs: 1800000, perStage: { 1: { totalTaskDurationSum: 1800000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded, runAggregates });
    expect(r.availableComputeHours).toBeCloseTo(2 * 1, 5); // 2 cores * 1h
    expect(r.driverWasteHours).toBeGreaterThan(0);
    expect(r.executorWasteHours).toBeGreaterThanOrEqual(0);
    expect(['driver', 'executor', null]).toContain(r.dominantWaste);
  });

  it('reports the zero-skew theoretical floor', () => {
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 1800000 }]]);
    const runAggregates = { busyCoreMs: 1800000, perStage: { 1: { totalTaskDurationSum: 3600000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded, runAggregates });
    expect(r.floorZeroSkewMs).toBe(3600000 / 2);  // total task time / total cores
  });
});
