import { describe, it, expect } from 'vitest';
import { normalizeStageName, matchStages, stageIdentity } from '../src/run-comparison.js';

function snap(stages, app = { name: 'App A' }) {
  return { app, stages: new Map(stages), sql: new Map(), catalog: [] };
}

describe('normalizeStageName', () => {
  it('strips run-varying digit runs and hex ids', () => {
    expect(normalizeStageName('Exchange 4821'))
      .toBe(normalizeStageName('Exchange 9137'));
    expect(normalizeStageName('scan parquet a1b2c3d4e5'))
      .toBe(normalizeStageName('scan parquet f9e8d7c6b5'));
  });
});

function planSnap(execId, planTree, app = { name: 'App A' }) {
  return { app, stages: new Map(), sql: new Map([[execId, { planTree }]]), catalog: [] };
}

function scan(relation) {
  return { name: `Scan parquet ${relation}`, detail: '', metrics: [], children: [] };
}

describe('stageIdentity (plan-tree structural identity)', () => {
  it('distinguishes two plans that share a node-name multiset but nest differently', () => {
    // Join(Filter(ScanA), ScanB) vs Filter(Join(ScanA, ScanB)): same node-name multiset, different tree shape.
    const filterA = { name: 'Filter', detail: 'isnotnull(id#1)', metrics: [], children: [scan('mx.a')] };
    const joinNested = {
      name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [filterA, scan('mx.b')],
    };
    const joinFlat = {
      name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [scan('mx.a'), scan('mx.b')],
    };
    const filterWrapping = { name: 'Filter', detail: 'isnotnull(id#1)', metrics: [], children: [joinFlat] };

    const stageA = { name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { name: 'Exchange 1', sqlExecutionId: 2 };
    const snapA = planSnap(1, joinNested);
    const snapB = planSnap(2, filterWrapping);

    expect(stageIdentity(stageA, snapA)).not.toBe(stageIdentity(stageB, snapB));
  });

  it('distinguishes two structurally identical joins on different columns', () => {
    const joinOnId = {
      name: 'SortMergeJoin', detail: '[id#1], [id#2], Inner', metrics: [], children: [scan('mx.a'), scan('mx.b')],
    };
    const joinOnName = {
      name: 'SortMergeJoin', detail: '[name#7], [name#8], Inner', metrics: [], children: [scan('mx.a'), scan('mx.b')],
    };
    const stageA = { name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { name: 'Exchange 1', sqlExecutionId: 2 };

    expect(stageIdentity(stageA, planSnap(1, joinOnId))).not.toBe(
      stageIdentity(stageB, planSnap(2, joinOnName))
    );
  });

  it('matches the same logical join despite AQE build-side, plan_id, and codegen noise differing across runs', () => {
    const baseJoin = {
      name: 'BroadcastHashJoin',
      detail: '[id#1], [id#2], Inner, BuildLeft, plan_id=5, [codegen id : 12]',
      metrics: [], children: [scan('mx.a'), scan('mx.b')],
    };
    const candJoin = {
      name: 'BroadcastHashJoin',
      detail: '[id#91], [id#42], Inner, BuildRight, plan_id=200, [codegen id : 3]',
      metrics: [], children: [scan('mx.a'), scan('mx.b')],
    };
    const stageA = { name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { name: 'Exchange 1', sqlExecutionId: 2 };

    expect(stageIdentity(stageA, planSnap(1, baseJoin))).toBe(
      stageIdentity(stageB, planSnap(2, candJoin))
    );
  });

  it('does not collide a scan whose detail embeds <>{}, characters with a differently-shaped node that reproduces the same characters across the name/detail boundary', () => {
    // Spark ReadSchema struct<...> detail embeds the same <>{}, delimiters a
    // node-boundary encoding uses, so it must not collide with a
    // boundary-shifted node. Text stays lowercase so normalizeStageName's
    // name-only lowercasing does not itself break the collision.
    const realisticScan = {
      name: 'scan parquet mx.a', detail: 'readschema: struct<id:bigint,name:string>', metrics: [], children: [],
    };
    const boundaryShiftedScan = {
      name: 'scan parquet mx.a<readschema: struct', detail: 'id:bigint,name:string>', metrics: [], children: [],
    };
    const stageA = { name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { name: 'Exchange 1', sqlExecutionId: 2 };

    expect(stageIdentity(stageA, planSnap(1, realisticScan))).not.toBe(
      stageIdentity(stageB, planSnap(2, boundaryShiftedScan))
    );
  });

  it('computes a bounded-size identity for a deep linear operator chain instead of blowing up exponentially', () => {
    // An identity that embeds each child's full identity string (not a
    // fixed-length digest) re-escapes the whole subtree at every level, so
    // length grows ~2^depth and blows up to megabytes or RangeError on the
    // 20-60+ deep chains real plans produce. Guard that a 40-deep chain still
    // computes quickly and stays short.
    let leaf = { name: 'Scan parquet mx.a', detail: 'ReadSchema: struct<id:bigint>', metrics: [], children: [] };
    let root = leaf;
    for (let i = 0; i < 40; i++) {
      root = { name: `Project ${i}`, detail: `[col${i}#${i}]`, metrics: [], children: [root] };
    }
    const stage = { name: 'Exchange 1', sqlExecutionId: 1 };
    const snap = planSnap(1, root);

    const start = performance.now();
    const identity = stageIdentity(stage, snap);
    const elapsedMs = performance.now() - start;

    expect(identity.length).toBeLessThan(500); // fixed-length digest, not 2^depth blowup
    expect(elapsedMs).toBeLessThan(1000); // sanity bound: should be near-instant
  });

  it('distinguishes two same-named stages sharing one SQL execution by their own attributed plan nodes, not the whole tree (issue #166 duplicatePlanSubtree case)', () => {
    // A self-join: two Exchange stages under one SQL execution, same normalized
    // name, each reading a different relation. Real Spark attributes each node
    // to the stage(s) whose task accumulables fed its metrics (`node.stageIds`).
    const scanA = { name: 'Scan parquet mx.a', detail: '', metrics: [], children: [], stageIds: [1] };
    const exchangeA = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [scanA], stageIds: [1] };
    const scanB = { name: 'Scan parquet mx.b', detail: '', metrics: [], children: [], stageIds: [2] };
    const exchangeB = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [scanB], stageIds: [2] };
    const join = { name: 'SortMergeJoin', detail: 'self-join', metrics: [], children: [exchangeA, exchangeB] };
    const snapshot = planSnap(1, join);
    const stageA = { id: 1, name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { id: 2, name: 'Exchange 2', sqlExecutionId: 1 };

    expect(normalizeStageName(stageA.name)).toBe(normalizeStageName(stageB.name)); // same normalized name
    expect(stageIdentity(stageA, snapshot)).not.toBe(stageIdentity(stageB, snapshot));
  });

  it('falls back to whole-tree identity when no node carries stage attribution (no stageIds anywhere)', () => {
    // Mirrors every other test in this block: hand-built plan nodes with no
    // `stageIds` field at all. Must behave exactly as before this change.
    const stageA = { id: 1, name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { id: 2, name: 'Exchange 2', sqlExecutionId: 1 };
    const snapshot = planSnap(1, { name: 'Exchange', detail: 'x', metrics: [], children: [] });

    expect(stageIdentity(stageA, snapshot)).toBe(stageIdentity(stageB, snapshot));
  });
});

describe('stageIdentity: Exchange split tree shape', () => {
  it('still distinguishes two same-named stages sharing one SQL execution when the plan uses split Exchange pairs (issue #166 case, re-verified post-split)', () => {
    const writeA = { name: 'Exchange', detail: '', metrics: [], children: [{ name: 'Scan parquet mx.a', detail: '', metrics: [], children: [], stageIds: [1] }], stageIds: [1], exchangeRole: 'write' };
    const readA = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [writeA], stageIds: [1], exchangeRole: 'read' };
    const writeB = { name: 'Exchange', detail: '', metrics: [], children: [{ name: 'Scan parquet mx.b', detail: '', metrics: [], children: [], stageIds: [2] }], stageIds: [2], exchangeRole: 'write' };
    const readB = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [writeB], stageIds: [2], exchangeRole: 'read' };
    const join = { name: 'SortMergeJoin', detail: 'self-join', metrics: [], children: [readA, readB] };
    const snapshot = planSnap(1, join);
    const stageA = { id: 1, name: 'Exchange 1', sqlExecutionId: 1 };
    const stageB = { id: 2, name: 'Exchange 2', sqlExecutionId: 1 };

    expect(normalizeStageName(stageA.name)).toBe(normalizeStageName(stageB.name));
    expect(stageIdentity(stageA, snapshot)).not.toBe(stageIdentity(stageB, snapshot));
  });

  it('produces the same identity for two structurally identical split-shaped trees (baseline vs. candidate of the same query)', () => {
    const buildTree = () => {
      const write = { name: 'Exchange', detail: '', metrics: [], children: [{ name: 'Scan parquet t', detail: '', metrics: [], children: [], stageIds: [1] }], stageIds: [1], exchangeRole: 'write' };
      const read = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [write], stageIds: [1], exchangeRole: 'read' };
      return { name: 'SortMergeJoin', detail: 'inner', metrics: [], children: [read] };
    };
    const baseline = planSnap(1, buildTree());
    const candidate = planSnap(1, buildTree());
    const stage = { id: 1, name: 'Exchange 1', sqlExecutionId: 1 };

    expect(stageIdentity(stage, baseline)).toBe(stageIdentity(stage, candidate));
  });
});

describe('matchStages', () => {
  it('pairs stages that share normalized name + sql identity', () => {
    const base = snap([[1, { name: 'Exchange 111', sqlExecutionId: null }]]);
    const cand = snap([[7, { name: 'Exchange 222', sqlExecutionId: null }]]);
    const m = matchStages(base, cand);
    expect(m.pairs).toEqual([{ identity: expect.any(String), baseId: 1, candId: 7 }]);
    expect(m.coverage).toBe(1);
    expect(m.collisionIdentities.size).toBe(0);
  });

  it('marks colliding identities instead of guessing a pairing', () => {
    const base = snap([
      [1, { name: 'Filter 1', sqlExecutionId: null }],
      [2, { name: 'Filter 2', sqlExecutionId: null }], // normalizes identically
    ]);
    const cand = snap([[8, { name: 'Filter 9', sqlExecutionId: null }]]);
    const m = matchStages(base, cand);
    expect(m.pairs).toHaveLength(0);
    expect(m.collisionIdentities.size).toBe(1);
  });

  it('pairs equal-size same-run collisions positionally by stage id instead of dropping them', () => {
    const base = snap([
      [1, { name: 'Filter 1', sqlExecutionId: null }],
      [2, { name: 'Filter 2', sqlExecutionId: null }], // normalizes identically to id 1
    ]);
    const cand = snap([
      [11, { name: 'Filter 11', sqlExecutionId: null }], // same identity, same count (2)
      [10, { name: 'Filter 10', sqlExecutionId: null }],
    ]);
    const m = matchStages(base, cand);
    expect(m.pairs).toEqual([
      { identity: expect.any(String), baseId: 1, candId: 10 },
      { identity: expect.any(String), baseId: 2, candId: 11 },
    ]);
    expect(m.coverage).toBe(1);
    expect(m.collisionIdentities.size).toBe(1); // still flagged as having been ambiguous
  });

  it('never records a collision for a same-run duplicatePlanSubtree pair when node-level attribution distinguishes them (issue #166 root cause)', () => {
    const scanA = { name: 'Scan parquet mx.a', detail: '', metrics: [], children: [], stageIds: [1] };
    const exchangeA = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [scanA], stageIds: [1] };
    const scanB = { name: 'Scan parquet mx.b', detail: '', metrics: [], children: [], stageIds: [2] };
    const exchangeB = { name: 'Exchange', detail: 'hashpartitioning(200)', metrics: [], children: [scanB], stageIds: [2] };
    const join = { name: 'SortMergeJoin', detail: 'self-join', metrics: [], children: [exchangeA, exchangeB] };
    const run = {
      app: { name: 'A' },
      stages: new Map([
        [1, { id: 1, name: 'Exchange 1', sqlExecutionId: 1 }],
        [2, { id: 2, name: 'Exchange 2', sqlExecutionId: 1 }],
      ]),
      sql: new Map([[1, { planTree: join }]]),
      catalog: [],
    };

    const m = matchStages(run, run); // self-compare: identical copy of one run against itself
    expect(m.coverage).toBe(1);
    expect(m.collisionIdentities.size).toBe(0); // distinguished up front, never even flagged
  });

  it('reports full coverage comparing two stage-less runs, instead of looking like total mismatch', () => {
    const empty = snap([]);
    const m = matchStages(empty, empty);
    expect(m.pairs).toHaveLength(0);
    expect(m.coverage).toBe(1); // nothing to compare, not "nothing matched"
  });
});

// --- metric deltas ---
import { metricDeltas } from '../src/run-comparison.js';

function stageFull(over) {
  return { name: 'Exchange 1', sqlExecutionId: null, submittedAt: 0, completedAt: 1000,
           taskDurationMax: 100, taskCount: 10, failedTasks: 0, memoryBytesSpilled: 0, ...over };
}
function fullSnap(stages, app) { return { app, stages: new Map(stages), sql: new Map(), catalog: [] }; }

describe('metricDeltas', () => {
  it('reports wall-clock, spill, skew p95, and failed-task-rate with direction', () => {
    const base = fullSnap([[1, stageFull({ memoryBytesSpilled: 1000, failedTasks: 2, taskCount: 10 })]],
                          { name: 'A', startTime: 0, endTime: 2000 });
    const cand = fullSnap([[1, stageFull({ memoryBytesSpilled: 400, failedTasks: 1, taskCount: 10 })]],
                          { name: 'A', startTime: 0, endTime: 1000 });
    const byKey = Object.fromEntries(metricDeltas(base, cand).map((m) => [m.key, m]));
    expect(byKey.wallClock.delta).toBe(-1000);
    expect(byKey.wallClock.direction).toBe('improvement');
    expect(byKey.shuffleSpill.baseline).toBe(1000);
    expect(byKey.shuffleSpill.candidate).toBe(400);
    expect(byKey.failedTaskRate.baseline).toBeCloseTo(0.2);
    expect(byKey.failedTaskRate.candidate).toBeCloseTo(0.1);
  });

  it('renders Unavailable with a reason when spill inputs are absent in a run', () => {
    const base = fullSnap([[1, stageFull({ memoryBytesSpilled: undefined })]], { name: 'A', startTime: 0, endTime: 1 });
    const cand = fullSnap([[1, stageFull({ memoryBytesSpilled: 500 })]], { name: 'A', startTime: 0, endTime: 1 });
    const spill = metricDeltas(base, cand).find((m) => m.key === 'shuffleSpill');
    expect(spill.baseline).toBeNull();
    expect(spill.direction).toBe('unavailable');
    expect(spill.unavailableReason).toMatch(/spill/i);
  });

  it('sums shuffle spill over the whole run, not the matched subset', () => {
    const matched = stageFull({ memoryBytesSpilled: 100 });
    const unmatched = stageFull({ name: 'Solo 1', memoryBytesSpilled: 900 });
    const base = fullSnap([[1, matched], [2, unmatched]], { name: 'A', startTime: 0, endTime: 10 });
    const cand = fullSnap([[1, stageFull({ memoryBytesSpilled: 100 })]], { name: 'A', startTime: 0, endTime: 10 });
    const spill = metricDeltas(base, cand).find((m) => m.key === 'shuffleSpill');
    expect(spill.baseline).toBe(1000); // 100 + 900, not just the matched 100
  });

  it('adds whole-run disk-spill, GC, IO-bytes, run-time, task-count and executor-count metrics', () => {
    const base = fullSnap([[1, stageFull({ diskBytesSpilled: 2000, jvmGCTime: 300, inputBytes: 5000, outputBytes: 1000, executorRunTime: 8000, taskCount: 10 })]],
                          { name: 'A', startTime: 0, endTime: 10 });
    base.executors = { added: [{ id: 'e1' }, { id: 'e2' }], removed: [] };
    const cand = fullSnap([[1, stageFull({ diskBytesSpilled: 500, jvmGCTime: 100, inputBytes: 5000, outputBytes: 1000, executorRunTime: 6000, taskCount: 10 })]],
                          { name: 'A', startTime: 0, endTime: 10 });
    cand.executors = { added: [{ id: 'e1' }], removed: [] };
    const byKey = Object.fromEntries(metricDeltas(base, cand).map((m) => [m.key, m]));
    expect(byKey.diskSpill.baseline).toBe(2000);
    expect(byKey.diskSpill.candidate).toBe(500);
    expect(byKey.diskSpill.direction).toBe('improvement');
    expect(byKey.gcTime.delta).toBe(-200);
    expect(byKey.inputBytes.direction).toBe('unchanged');
    expect(byKey.executorRunTime.delta).toBe(-2000);
    expect(byKey.taskCount.baseline).toBe(10);
    expect(byKey.executorsAdded.baseline).toBe(2);
    expect(byKey.executorsAdded.candidate).toBe(1);
  });

  it('renders executor-count Unavailable when a snapshot has no executor events', () => {
    const base = fullSnap([[1, stageFull({})]], { name: 'A', startTime: 0, endTime: 10 }); // no .executors
    const cand = fullSnap([[1, stageFull({})]], { name: 'A', startTime: 0, endTime: 10 });
    const ex = metricDeltas(base, cand).find((m) => m.key === 'executorsAdded');
    expect(ex.baseline).toBeNull();
    expect(ex.direction).toBe('unavailable');
  });

  it('reports neutral (not regression) when a volume/count metric increases', () => {
    // More input/output/tasks/executors is more work, not worse work, so neutral not regression.
    const base = fullSnap([[1, stageFull({ inputBytes: 5000, outputBytes: 1000, taskCount: 10 })]],
                          { name: 'A', startTime: 0, endTime: 10 });
    base.executors = { added: [{ id: 'e1' }], removed: [] };
    const cand = fullSnap([[1, stageFull({ inputBytes: 8000, outputBytes: 2000, taskCount: 20 })]],
                          { name: 'A', startTime: 0, endTime: 10 });
    cand.executors = { added: [{ id: 'e1' }, { id: 'e2' }], removed: [] };
    const byKey = Object.fromEntries(metricDeltas(base, cand).map((m) => [m.key, m]));
    expect(byKey.inputBytes.direction).toBe('neutral');
    expect(byKey.outputBytes.direction).toBe('neutral');
    expect(byKey.taskCount.direction).toBe('neutral');
    expect(byKey.executorsAdded.direction).toBe('neutral');
    // A real regression metric still reports 'regression' for an increase, so this isn't a blanket change.
    expect(byKey.gcTime).toBeDefined();
  });
});

// --- findings delta ---
import { findingsDelta } from '../src/run-comparison.js';

function catSnap(stages, catalog, app = { name: 'A' }) {
  return { app, stages: new Map(stages), sql: new Map(), catalog };
}

describe('findingsDelta (category counts)', () => {
  it('reports categories the candidate has more of as introduced', () => {
    const base = catSnap([], [{ rule: 'spill', impactBand: 'warn' }]);
    const cand = catSnap([], [{ rule: 'spill', impactBand: 'warn' }, { rule: 'spill', impactBand: 'warn' }, { rule: 'skew', impactBand: 'high' }]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([
      { rule: 'skew', impactBand: 'high', baseCount: 0, candCount: 1, delta: 1, stages: [] },
      { rule: 'spill', impactBand: 'warn', baseCount: 1, candCount: 2, delta: 1, stages: [] },
    ]);
    expect(d.resolved).toEqual([]);
  });

  it('reports categories the candidate has fewer of as resolved', () => {
    const base = catSnap([], [{ rule: 'gc', impactBand: 'high' }, { rule: 'gc', impactBand: 'high' }]);
    const cand = catSnap([], [{ rule: 'gc', impactBand: 'high' }]);
    const d = findingsDelta(base, cand);
    expect(d.resolved).toEqual([{ rule: 'gc', impactBand: 'high', baseCount: 2, candCount: 1, delta: -1, stages: [] }]);
    expect(d.introduced).toEqual([]);
  });

  it('labels each category with the stage names from the side that has more', () => {
    const stages = [[10, { name: 'Exchange 10' }], [11, { name: 'Sort 11' }]];
    const base = catSnap([], []);
    const cand = catSnap(stages, [
      { rule: 'spill', impactBand: 'warn', stageId: 10 },
      { rule: 'spill', impactBand: 'warn', stageId: 11 },
    ]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([
      { rule: 'spill', impactBand: 'warn', baseCount: 0, candCount: 2, delta: 2, stages: ['Exchange 10', 'Sort 11'] },
    ]);
  });

  it('omits a category present in equal counts on both sides', () => {
    const base = catSnap([], [{ rule: 'gc', impactBand: 'high' }]);
    const cand = catSnap([], [{ rule: 'gc', impactBand: 'high' }]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([]);
    expect(d.resolved).toEqual([]);
  });

  it('splits an impact band shift into one resolved + one introduced row', () => {
    const base = catSnap([], [{ rule: 'skew', impactBand: 'warn' }]);
    const cand = catSnap([], [{ rule: 'skew', impactBand: 'critical' }]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([{ rule: 'skew', impactBand: 'critical', baseCount: 0, candCount: 1, delta: 1, stages: [] }]);
    expect(d.resolved).toEqual([{ rule: 'skew', impactBand: 'warn', baseCount: 1, candCount: 0, delta: -1, stages: [] }]);
  });

  it('falls back to type when rule is absent and to "unknown" impact band', () => {
    const base = catSnap([], []);
    const cand = catSnap([], [{ type: 'coldStart' }]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([{ rule: 'coldStart', impactBand: 'unknown', baseCount: 0, candCount: 1, delta: 1, stages: [] }]);
  });
});

// --- compareRuns assembler ---
import { compareRuns } from '../src/run-comparison.js';

const B = (stages, app) => ({ label: 'base.log', snapshot: { app, stages: new Map(stages), sql: new Map(), catalog: [] } });
const C = (stages, app) => ({ label: 'cand.log', snapshot: { app, stages: new Map(stages), sql: new Map(), catalog: [] } });

describe('compareRuns', () => {
  it('sets low confidence (not unavailable) when app names differ, still computing metrics', () => {
    const m = compareRuns(B([[1, { name: 'X 1' }]], { name: 'App A' }),
                          C([[1, { name: 'X 1' }]], { name: 'App B' }));
    expect(m.confidence).toBe('low');
    expect(m.reason).toMatch(/name/i);
    expect(m.metrics.length).toBeGreaterThan(0); // deltas still computed across different names
    expect(m.findings).toBeDefined();
  });

  it('is ok with aligned stages and reports coverage + labels', () => {
    const m = compareRuns(B([[1, { name: 'Exchange 1' }]], { name: 'A' }),
                          C([[9, { name: 'Exchange 2' }]], { name: 'A' }));
    expect(m.confidence).toBe('ok');
    expect(m.matchedCoverage).toBe(1);
    expect(m.baselineLabel).toBe('base.log');
    expect(m.candidateLabel).toBe('cand.log');
    expect(m.metrics.length).toBe(11);
  });

  it('is deterministic and load-order independent given fixed roles', () => {
    const a = B([[1, { name: 'Exchange 1' }]], { name: 'A' });
    const b = C([[9, { name: 'Exchange 2' }]], { name: 'A' });
    expect(JSON.stringify(compareRuns(a, b))).toBe(JSON.stringify(compareRuns(a, b)));
  });

  it('reports full coverage comparing a run against an identical copy of itself, even with same-run identity collisions (issue #166)', () => {
    const stages = [
      [1, { name: 'Filter 1', sqlExecutionId: null }],
      [2, { name: 'Filter 2', sqlExecutionId: null }], // collides with stage 1 after normalization
      [3, { name: 'Exchange 1', sqlExecutionId: null }],
    ];
    const app = { name: 'A' };
    const m = compareRuns(B(stages, app), C(stages, app));
    expect(m.matchedCoverage).toBe(1);
  });
});

describe('compareRuns confidence', () => {
  const run = (catalog, app, label) => ({ label, snapshot: { app, stages: new Map(), sql: new Map(), catalog } });

  it("is 'low' (never 'unavailable') when application names differ", () => {
    const b = run([], { name: 'JobX', startTime: 0, endTime: 10 }, 'base');
    const c = run([], { name: 'JobY', startTime: 0, endTime: 10 }, 'cand');
    const m = compareRuns(b, c);
    expect(m.confidence).toBe('low');
    expect(m.reason).toMatch(/differ/i);
  });

  it("is 'ok' for same-named runs even with zero matched stages (coverage 1: both runs are stage-less)", () => {
    const b = run([{ rule: 'spill', impactBand: 'warn' }], { name: 'JobX', startTime: 0, endTime: 10 }, 'base');
    const c = run([], { name: 'JobX', startTime: 0, endTime: 20 }, 'cand');
    const m = compareRuns(b, c);
    expect(m.confidence).toBe('ok');
    expect(m.findings.resolved).toHaveLength(1);        // spill/warn present in base, absent in cand
    expect(m.metrics.find((x) => x.key === 'wallClock').delta).toBe(10);
  });

  it("is 'ok' when names match and most stages pair off (high coverage)", () => {
    const stages = [
      [1, { name: 'Exchange 1', sqlExecutionId: null }],
      [2, { name: 'Filter 1', sqlExecutionId: null }],
    ];
    const b = { label: 'base', snapshot: { app: { name: 'JobX' }, stages: new Map(stages), sql: new Map(), catalog: [] } };
    const c = { label: 'cand', snapshot: { app: { name: 'JobX' }, stages: new Map(stages), sql: new Map(), catalog: [] } };
    const m = compareRuns(b, c);
    expect(m.matchedCoverage).toBe(1);
    expect(m.confidence).toBe('ok');
    expect(m.reason).toBeNull();
  });

  it("is 'low' when names match but stage coverage is poor, and explains why", () => {
    // Base has 4 stages, candidate shares only 1 identity with it: pairs.length
    // = 1, total = 4 + 4 = 8, coverage = 2*1/8 = 0.25 (below the 0.5 threshold).
    const b = run([], { name: 'JobX', startTime: 0, endTime: 10 }, 'base');
    b.snapshot.stages = new Map([
      [1, { name: 'Shared 1', sqlExecutionId: null }],
      [2, { name: 'BaseOnly 1', sqlExecutionId: null }],
      [3, { name: 'BaseOnly 2', sqlExecutionId: null }],
      [4, { name: 'BaseOnly 3', sqlExecutionId: null }],
    ]);
    const c = run([], { name: 'JobX', startTime: 0, endTime: 10 }, 'cand');
    c.snapshot.stages = new Map([
      [11, { name: 'Shared 2', sqlExecutionId: null }],
      [12, { name: 'CandOnly 1', sqlExecutionId: null }],
      [13, { name: 'CandOnly 2', sqlExecutionId: null }],
      [14, { name: 'CandOnly 3', sqlExecutionId: null }],
    ]);
    const m = compareRuns(b, c);
    expect(m.matchedCoverage).toBeCloseTo(0.25);
    expect(m.confidence).toBe('low');
    expect(m.reason).toMatch(/25%/);
    expect(m.reason).not.toMatch(/name/i); // names match here, so the reason must not blame naming
  });

  it("still reports 'low' with a name-mismatch reason when names differ even if coverage happens to be high", () => {
    const stages = [[1, { name: 'Exchange 1', sqlExecutionId: null }]];
    const b = { label: 'base', snapshot: { app: { name: 'JobX' }, stages: new Map(stages), sql: new Map(), catalog: [] } };
    const c = { label: 'cand', snapshot: { app: { name: 'JobY' }, stages: new Map(stages), sql: new Map(), catalog: [] } };
    const m = compareRuns(b, c);
    expect(m.matchedCoverage).toBe(1);
    expect(m.confidence).toBe('low');
    expect(m.reason).toMatch(/differ/i);
    expect(m.reason).not.toMatch(/%/); // high coverage, so the reason should not also claim poor matching
  });
});

// --- Review regressions ---
describe('findingsDelta: app-level findings sharing a rule (bug C1)', () => {
  it('counts distinct severities of one rule separately', () => {
    const base = catSnap([], [
      { type: 'memoryUtilization', stageId: null, impactBand: 'warning' },
      { type: 'memoryUtilization', stageId: null, impactBand: 'info' }, // resolved next run
    ]);
    const cand = catSnap([], [
      { type: 'memoryUtilization', stageId: null, impactBand: 'warning' }, // unchanged
    ]);
    const d = findingsDelta(base, cand);
    expect(d.introduced).toEqual([]);
    expect(d.resolved).toEqual([{ rule: 'memoryUtilization', impactBand: 'info', baseCount: 1, candCount: 0, delta: -1, stages: [] }]);
  });
});

describe('metricDeltas: failed-task rate with absent failedTasks (bug C2)', () => {
  it('renders Unavailable, not a false 0/unchanged, when failedTasks is absent in both runs', () => {
    const base = fullSnap([[1, stageFull({ failedTasks: undefined, taskCount: 10 })]], { name: 'A', startTime: 0, endTime: 1 });
    const cand = fullSnap([[1, stageFull({ failedTasks: undefined, taskCount: 10 })]], { name: 'A', startTime: 0, endTime: 1 });
    const fr = metricDeltas(base, cand).find((m) => m.key === 'failedTaskRate');
    expect(fr.baseline).toBeNull();
    expect(fr.candidate).toBeNull();
    expect(fr.direction).toBe('unavailable');
    expect(fr.unavailableReason).toMatch(/task|fail/i);
  });
});

// --- per-stage summaries for manual pinning ---
describe('compareRuns per-stage summaries', () => {
  it('exposes id, name, and per-field metrics for every stage on both sides', () => {
    const s = (over) => stageFull({ submittedAt: 0, completedAt: 1000, diskBytesSpilled: 40, jvmGCTime: 5,
      inputBytes: 700, outputBytes: 200, executorRunTime: 900, taskCount: 8, failedTasks: 1, ...over });
    const m = compareRuns(
      B([[1, s({ name: 'Exchange 1', memoryBytesSpilled: 100 })]], { name: 'A' }),
      C([[9, s({ name: 'Exchange 2', memoryBytesSpilled: 250 })]], { name: 'A' }),
    );
    expect(m.baseStages).toEqual([
      { id: 1, name: 'Exchange 1', metrics: { duration: 1000, memoryBytesSpilled: 100, diskBytesSpilled: 40,
        jvmGCTime: 5, inputBytes: 700, outputBytes: 200, executorRunTime: 900, taskCount: 8, failedTasks: 1 } },
    ]);
    expect(m.candStages[0].id).toBe(9);
    expect(m.candStages[0].metrics.memoryBytesSpilled).toBe(250);
  });

  it('nulls a stage duration that is not positive', () => {
    const m = compareRuns(
      B([[1, { name: 'X 1', submittedAt: 500, completedAt: 500 }]], { name: 'A' }),
      C([[2, { name: 'X 2', submittedAt: 0, completedAt: 10 }]], { name: 'A' }),
    );
    expect(m.baseStages[0].metrics.duration).toBeNull();
    expect(m.candStages[0].metrics.duration).toBe(10);
  });
});

// --- shared Markdown renderer ---
import { renderComparisonMarkdown } from '../src/run-comparison.js';

describe('renderComparisonMarkdown', () => {
  it('renders the confidence/coverage/metrics/findings sections', () => {
    const m = compareRuns(
      B([[1, { name: 'X 1', submittedAt: 0, completedAt: 100 }]], { name: 'JobX' }),
      C([[9, { name: 'X 2', submittedAt: 0, completedAt: 200 }]], { name: 'JobY' }),
    );
    const md = renderComparisonMarkdown(m);
    expect(md).toMatch(/^\n## Comparison to baseline\n/);
    expect(md).toMatch(/- confidence: low, .*name/i);
    expect(md).toMatch(/- matched stage coverage: 100\.0%/);
    expect(md).toMatch(/### Metric deltas\n\n- Wall-clock duration: 100 -> 200 \(regression\)/);
    expect(md).toMatch(/### Introduced findings \(0\)/);
    expect(md).toMatch(/### Resolved findings \(0\)/);
  });

  it('lists one bullet per introduced/resolved finding', () => {
    const run = (catalog, app, label) => ({ label, snapshot: { app, stages: new Map(), sql: new Map(), catalog } });
    const b = run([{ type: 'spill', impactBand: 'warning' }], { name: 'JobX' }, 'base');
    const c = run([{ type: 'gc', impactBand: 'critical' }], { name: 'JobX' }, 'cand');
    const md = renderComparisonMarkdown(compareRuns(b, c));
    expect(md).toMatch(/### Introduced findings \(1\)\n\n- \[critical\] gc: 0 -> 1/);
    expect(md).toMatch(/### Resolved findings \(1\)\n\n- \[warning\] spill: 1 -> 0/);
  });
});
