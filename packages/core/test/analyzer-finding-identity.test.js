import { describe, it, expect } from 'vitest';
import { analyze, findingId } from '../src/analyzer.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

// Fixture with two flagging stages + a GB shuffle so we get >1 finding.
function fixture() {
  const stages = new Map([
    [1, makeStage({ id: 1, taskDurationP50: 100, taskDurationP95: 600 })],       // skew critical
    [2, makeStage({ id: 2, shuffleReadBytes: 2 * 1024 * 1024 * 1024 })],         // shuffle critical
  ]);
  return { app: makeApp(), stages, added: [], removed: [], jobs: new Map() };
}

describe('analyze: finding identity + detector version', () => {
  it('stamps every finding with a string id and a numeric detectorVersion', () => {
    const { app, stages, added, removed, jobs } = fixture();
    const findings = analyze(app, stages, added, removed, jobs);
    expect(findings.length).toBeGreaterThan(0);
    for (const f of findings) {
      expect(typeof f.id).toBe('string');
      expect(f.id.length).toBeGreaterThan(0);
      expect(typeof f.detectorVersion).toBe('number');
      expect(f.detectorVersion).toBeGreaterThanOrEqual(1);
    }
  });

  it('is deterministic: same input yields identical ids and identical ordering', () => {
    const a = fixture();
    const b = fixture();
    const ra = analyze(a.app, a.stages, a.added, a.removed, a.jobs);
    const rb = analyze(b.app, b.stages, b.added, b.removed, b.jobs);
    expect(ra.map((f) => f.id)).toEqual(rb.map((f) => f.id));
    expect(ra.map((f) => `${f.type}:${f.stageId}`)).toEqual(rb.map((f) => `${f.type}:${f.stageId}`));
  });

  it('derives the id from type + location + metric (no timestamp/randomness)', () => {
    const { app, stages, added, removed, jobs } = fixture();
    const findings = analyze(app, stages, added, removed, jobs);
    const skew = findings.find((f) => f.type === 'skew' && f.stageId === 1);
    const skewAgain = analyze(app, stages, added, removed, jobs).find((f) => f.type === 'skew' && f.stageId === 1);
    expect(skew.id).toBe(skewAgain.id);
    const shuffle = findings.find((f) => f.type === 'shuffle' && f.stageId === 2);
    expect(shuffle.id).not.toBe(skew.id);
  });

  it('id is decoupled from detectorVersion: a version bump alone does not change the id', () => {
    const base = { type: 'skew', stageId: 1, metric: 'taskDurationP95Ratio', value: 6 };
    const idV1 = findingId({ ...base, detectorVersion: 1 });
    const idV2 = findingId({ ...base, detectorVersion: 2 });
    expect(idV1).toBe(idV2);
  });

  it('attaching impactEstimate never perturbs the FNV-1a id hash', () => {
    const { app, stages, added, removed, jobs } = fixture();
    const findings = analyze(app, stages, added, removed, jobs);
    for (const f of findings) {
      if (f.impactEstimate) {
        const { impactEstimate, ...withoutEstimate } = f;
        const idWithout = findingId(withoutEstimate);
        expect(f.id).toBe(idWithout);
      }
    }
  });
});

// Fixture tripping detectors that emit multiple findings on the same location+metric,
// differing only by a discriminator (slowHost by host, memoryUtilization by executorId);
// these collide under an id keyed on type|location|metric alone.
const ALLOC_MB = 1000;
const ALLOC_BYTES = ALLOC_MB * 1024 * 1024;

function collisionFixture() {
  // 3 fast hosts (mean 10000ms) + 2 slow (mean 30000ms, 3×); durations must clear
  // slowHost's 1s magnitude floor or they'd be suppressed as noise regardless of ratio.
  const hostStats = [
    { host: 'ip-10-1-2', taskCount: 20, totalDuration: 200000 },
    { host: 'ip-10-1-3', taskCount: 20, totalDuration: 200000 },
    { host: 'ip-10-1-4', taskCount: 20, totalDuration: 200000 },
    { host: 'ip-10-1-5', taskCount: 20, totalDuration: 600000 },
    { host: 'ip-10-1-6', taskCount: 20, totalDuration: 600000 },
  ];
  // Two executors well under allocated heap => two per-executor memoryBand findings.
  const executorMetrics = new Map([
    ['1', { jvmHeapMemory: Math.round(0.5 * ALLOC_BYTES) }],
    ['2', { jvmHeapMemory: Math.round(0.4 * ALLOC_BYTES) }],
  ]);
  const stages = new Map([
    [1, makeStage({ id: 1, taskCount: 100, hostStats })],
    [2, makeStage({ id: 2, taskCount: 10, executorMetrics })],
  ]);
  const app = makeApp({ resources: { executor: { memoryMB: ALLOC_MB } } });
  return { app, stages, added: [], removed: [], jobs: new Map() };
}

describe('analyze: finding id uniqueness across multi-emit detectors', () => {
  it('emits >=2 slowHost (per host) and >=2 memoryUtilization (per executor) findings', () => {
    const { app, stages, added, removed, jobs } = collisionFixture();
    const findings = analyze(app, stages, added, removed, jobs);
    const slowHosts = findings.filter((f) => f.type === 'slowHost' && f.metric === 'hostMeanRatio');
    const memBands = findings.filter((f) => f.type === 'memoryUtilization' && f.metric === 'heapUsedRatio');
    expect(slowHosts.length).toBeGreaterThanOrEqual(2);
    expect(memBands.length).toBeGreaterThanOrEqual(2);
  });

  it('assigns a unique id to every finding (no discriminator collisions)', () => {
    const { app, stages, added, removed, jobs } = collisionFixture();
    const ids = analyze(app, stages, added, removed, jobs).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// SQL Plan-Advisor detectors emit multiple findings per execution differing only by
// discriminator fields: smallFiles (direction/nodeName), duplicatePlanSubtree (rootName/subtreeSize).
const MB = 1024 * 1024;
const planNode = (name, metrics = [], children = []) => ({
  name, detail: '', metrics: metrics.map((m) => ({ ...m, metricType: 'sum' })), children,
});

function sqlCollisionFixture() {
  // Read side + write side, both tripping smallFiles, differing only by direction/nodeName.
  const readScan = planNode('Scan parquet db.read_tbl', [
    { name: 'number of files read', value: 500 },
    { name: 'size of files read', value: 500 * 1 * MB * 0.001 }, // avg ~1KB
  ]);
  const writeExec = planNode('InsertIntoHadoopFsRelation db.write_tbl', [
    { name: 'number of written files', value: 800 },
    { name: 'written output', value: 800 * 1 * MB * 0.001 },
  ]);
  // Two distinct 3-node duplicate subtrees (different roots) in one plan.
  const dupA = () => planNode('SortMergeJoin', [], [planNode('Sort'), planNode('Sort')]);
  const dupB = () => planNode('HashAggregate', [], [planNode('Exchange'), planNode('Exchange')]);
  const planTree = planNode('Project', [], [readScan, writeExec, dupA(), dupA(), dupB(), dupB()]);
  const sqlExec = { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], physicalPlanDescription: '', planTree };
  const sql = new Map([[1, sqlExec]]);
  const stages = new Map([[1, makeStage({ id: 1, sqlExecutionId: 1 })]]);
  return { app: makeApp(), stages, sql };
}

describe('analyze: finding id uniqueness across SQL plan-advisor detectors', () => {
  it('emits >=2 smallFiles (read+write) and >=2 duplicatePlanSubtree findings', () => {
    const { app, stages, sql } = sqlCollisionFixture();
    const findings = analyze(app, stages, [], [], new Map(), sql);
    expect(findings.filter((f) => f.type === 'smallFiles').length).toBeGreaterThanOrEqual(2);
    expect(findings.filter((f) => f.type === 'duplicatePlanSubtree').length).toBeGreaterThanOrEqual(2);
  });

  it('assigns a unique id to every finding (SQL siblings do not collide)', () => {
    const { app, stages, sql } = sqlCollisionFixture();
    const ids = analyze(app, stages, [], [], new Map(), sql).map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('analyze, finding id uniqueness for app-scope, per-instance findings', () => {
  it('rddId discriminates cacheUtilization findings sharing type/metric/value with no stage/execution/property location', () => {
    const a = { type: 'cacheUtilization', stageId: null, variant: 'partialCache', metric: 'cachedRatio', value: 40, rddId: 1 };
    const b = { type: 'cacheUtilization', stageId: null, variant: 'partialCache', metric: 'cachedRatio', value: 40, rddId: 2 };
    expect(findingId(a)).not.toBe(findingId(b));
  });

  // Leaf cachingOpportunity findings share type/stageId/metric/value across distinct
  // relations; only relation/format distinguish them. Composites additionally share
  // relation across distinct operators and can share everything but executionIds.
  it('relation/format discriminate leaf cachingOpportunity findings sharing type/stageId/metric/value', () => {
    const a = { type: 'cachingOpportunity', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t1', format: 'parquet', executionIds: [1, 2] };
    const b = { type: 'cachingOpportunity', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t2', format: 'parquet', executionIds: [1, 2] };
    expect(findingId(a)).not.toBe(findingId(b));
  });

  it('operator discriminates composite cachingOpportunity findings sharing type/stageId/metric/value/relation', () => {
    const a = { type: 'cachingOpportunity', variant: 'composite', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t1 join db.t2', operator: 'join', executionIds: [1, 2] };
    const b = { type: 'cachingOpportunity', variant: 'composite', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t1 join db.t2', operator: 'union', executionIds: [1, 2] };
    expect(findingId(a)).not.toBe(findingId(b));
  });

  it('executionIds discriminates cachingOpportunity findings sharing type/stageId/metric/value/relation/format/operator', () => {
    const a = { type: 'cachingOpportunity', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t1', format: 'parquet', executionIds: [1, 2] };
    const b = { type: 'cachingOpportunity', stageId: null, metric: 'executionReuse', value: 2, relation: 'db.t1', format: 'parquet', executionIds: [3, 4] };
    expect(findingId(a)).not.toBe(findingId(b));
  });
});
