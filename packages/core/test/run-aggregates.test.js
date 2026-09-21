import { describe, it, expect } from 'vitest';
import { computeRunAggregates } from '../src/run-aggregates.js';
import { FIELDS } from '../src/parser-worker.js';

// Build stage Float64Arrays in the live stride-8 layout; only DURATION, LAUNCH_TIME, FINISH_TIME are set.
function makeTaskStore(stages) {
  const store = new Map();
  for (const [stageId, tasks] of Object.entries(stages)) {
    const buf = [];
    for (const { launch, finish } of tasks) {
      const rec = new Array(FIELDS.STRIDE).fill(0);
      rec[FIELDS.DURATION] = finish - launch;
      rec[FIELDS.LAUNCH_TIME] = launch;
      rec[FIELDS.FINISH_TIME] = finish;
      buf.push(...rec);
    }
    store.set(Number(stageId), new Float64Array(buf));
  }
  return store;
}

describe('computeRunAggregates', () => {
  it('sums busy-core-ms and peak concurrency across all stages', () => {
    // Stage 1: [0,1000). Stage 2: [500,1500). Peak overlap = 2 cores.
    const store = makeTaskStore({ 1: [{ launch: 0, finish: 1000 }], 2: [{ launch: 500, finish: 1500 }] });
    const r = computeRunAggregates(store);
    // busy=1 for 1000ms, busy=2 for 500ms => 1*1000 + 2*500 = 2000 busy-core-ms.
    expect(r.busyCoreMs).toBe(2000);
    expect(r.peakConcurrentCores).toBe(2);
  });

  it('reports per-stage total task duration and count', () => {
    const store = makeTaskStore({ 7: [{ launch: 0, finish: 300 }, { launch: 0, finish: 700 }] });
    const r = computeRunAggregates(store);
    expect(r.perStage[7]).toEqual({ totalTaskDurationSum: 1000, taskCount: 2 });
  });

  it('returns zeroed aggregates for an empty store', () => {
    const r = computeRunAggregates(new Map());
    expect(r).toEqual({ coreHistogram: [], busyCoreMs: 0, peakConcurrentCores: 0, perStage: {} });
  });
});
