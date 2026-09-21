import { describe, it, expect } from 'vitest';
import { captureSnapshot, applySnapshot } from '../src/session-snapshot.js';

function mkModel() {
  return {
    app: { name: 'App A' },
    stages: new Map([[1, { id: 1 }]]),
    executors: { added: [{ id: 'e1' }], removed: [] },
    sql: new Map([[0, { id: 0 }]]),
    jobs: new Map(),
    runAggregates: { busyCoreMs: 111, perStage: { 1: { taskMs: 5 } } },
    evidenceAvailability: {
      schemaVersion: 1,
      entries: [{ key: 'taskCoreTime', state: 'present', reasonCode: 'observed', summary: 'Observed in this event log.' }],
    },
  };
}

describe('session-snapshot', () => {
  it('captures a snapshot decoupled from later live mutation', () => {
    const model = mkModel();
    const taskData = new Map([[1, { metrics: new Float64Array([1, 2]), fieldNames: ['duration'] }]]);
    const snap = captureSnapshot(model, [{ kind: 'skew', stageId: 1 }], taskData);

    // Mutate the live model afterwards; snapshot must not change.
    model.stages.set(2, { id: 2 });
    taskData.delete(1);

    expect(snap.stages.has(2)).toBe(false);
    expect(snap.taskData.has(1)).toBe(true);
    expect(snap.catalog).toHaveLength(1);
  });

  it('applies a snapshot into the same live objects (mutates in place)', () => {
    const liveModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map() };
    const liveCache = new Map();

    const source = mkModel();
    const snap = captureSnapshot(source, [{ kind: 'gc', stageId: 3 }], new Map([[3, { metrics: new Float64Array([9]), fieldNames: ['duration'] }]]));

    const returnedModel = liveModel; // keep the reference to prove in-place mutation
    const catalog = applySnapshot(liveModel, liveCache, snap);

    expect(liveModel).toBe(returnedModel);
    expect(liveModel.app).toEqual({ name: 'App A' });
    expect(liveModel.stages.get(1)).toEqual({ id: 1 });
    expect(liveCache.get(3).fieldNames).toEqual(['duration']);
    expect(catalog).toEqual([{ kind: 'gc', stageId: 3 }]);
  });

  it('round-trips runAggregates so switching files never mixes one run with another run\'s core-time-series', () => {
    // File A parsed, then File B overwrites the live runAggregates.
    const modelA = mkModel();
    const snapA = captureSnapshot(modelA, [], new Map());

    const live = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: { busyCoreMs: 999, perStage: {} } };
    applySnapshot(live, new Map(), snapA);

    expect(live.runAggregates).toEqual({ busyCoreMs: 111, perStage: { 1: { taskMs: 5 } } });
  });

  it('restores runAggregates to null when the snapshot has none', () => {
    const model = mkModel();
    model.runAggregates = null;
    const snap = captureSnapshot(model, [], new Map());

    const live = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: { busyCoreMs: 7 } };
    applySnapshot(live, new Map(), snap);

    expect(live.runAggregates).toBeNull();
  });

  it('round-trips the exact evidence availability ledger and defaults old snapshots to null', () => {
    const source = mkModel();
    const snap = captureSnapshot(source, [], new Map());
    const live = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null };

    applySnapshot(live, new Map(), snap);
    expect(live.evidenceAvailability).toEqual(source.evidenceAvailability);

    delete snap.evidenceAvailability;
    applySnapshot(live, new Map(), snap);
    expect(live.evidenceAvailability).toBeNull();
  });
});
