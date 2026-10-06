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

  it('measures capacity as the allocation: an executor that joins late is counted from when it joined', () => {
    // A second 2-core executor joins at the half-hour: 4 cores at the peak, 3 core-hours allocated.
    // One core busy for the hour leaves 2 of the 3 unused.
    const late = [...executorsAdded, { executorId: '2', timestamp: 1800000, totalCores: 2 }];
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 3600000 }]]);
    const runAggregates = { busyCoreMs: 3600000, perStage: { 1: { totalTaskDurationSum: 3600000, taskCount: 4 } } };
    const r = computeEfficiencyModel({ app, stages, executorsAdded: late, executorsRemoved: [], runAggregates });
    expect(r.availableComputeHours).toBeCloseTo(3, 5);
    expect(r.wastagePct).toBe(67);
    // The floor still uses the widest the cluster was.
    expect(r.floorZeroSkewMs).toBe(3600000 / 4);
  });

  it('charges the driver only for cores held outside the stages: late executors hold none at startup', () => {
    // A 100 s run whose only stage runs 60-100 s. A 2-core executor joins at 50 s, so 100 core-s
    // are allocated: 20 outside the stage (50-60 s) and 80 inside it. Spread evenly over the run
    // (1 core on average) the 60 s of startup would bill the driver 60 core-s and flip the
    // dominant waste to the driver.
    const lateApp = { startTime: 0, endTime: 100000, resources: { executor: { cores: 2 } } };
    const stages = new Map([[1, { id: 1, submittedAt: 60000, completedAt: 100000 }]]);
    const runAggregates = { busyCoreMs: 40000, perStage: {} };
    const added = [{ executorId: '1', timestamp: 50000, totalCores: 2 }];
    const r = computeEfficiencyModel({ app: lateApp, stages, executorsAdded: added, executorsRemoved: [], runAggregates });
    expect(r.availableComputeHours).toBeCloseTo(100000 / 3600000, 12);
    expect(r.driverWasteHours).toBeCloseTo(20000 / 3600000, 12);
    expect(r.executorWasteHours).toBeCloseTo(40000 / 3600000, 12);
    expect(r.dominantWaste).toBe('executor');
    expect(r.wastagePct).toBe(60);
  });

  it('splits an executor that spans a gap between stages by the time it was alive in each part', () => {
    // One 1-core executor for the whole 100 s run; stages at 10-30 s and 70-90 s are active for 40 s.
    // 60 core-s are held while no stage ran, 40 inside the stages, all of it busy.
    const gapApp = { startTime: 0, endTime: 100000, resources: { executor: { cores: 1 } } };
    const stages = new Map([[1, { id: 1, submittedAt: 10000, completedAt: 30000 }], [2, { id: 2, submittedAt: 70000, completedAt: 90000 }]]);
    const added = [{ executorId: '1', timestamp: 0, totalCores: 1 }];
    const r = computeEfficiencyModel({ app: gapApp, stages, executorsAdded: added, executorsRemoved: [], runAggregates: { busyCoreMs: 40000, perStage: {} } });
    expect(r.driverWasteHours).toBeCloseTo(60000 / 3600000, 12);
    expect(r.executorWasteHours).toBe(0);
    expect(r.dominantWaste).toBe('driver');
  });

  it('has no capacity, so no wastage figure, when the executors report no cores', () => {
    const stages = new Map([[1, { id: 1, submittedAt: 0, completedAt: 3600000 }]]);
    const runAggregates = { busyCoreMs: 1800000, perStage: {} };
    const unknown = [{ executorId: '1', timestamp: 0, totalCores: 0 }];
    const r = computeEfficiencyModel({ app: { ...app, resources: { executor: { cores: null } } }, stages, executorsAdded: unknown, executorsRemoved: [], runAggregates });
    expect(r.availableComputeHours).toBe(0);
    expect(r.wastagePct).toBeNull();
  });

  it('counts a replaced executor once: its cores are allocated only while it is alive', () => {
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
