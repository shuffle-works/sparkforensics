import { describe, it, expect } from 'vitest';
import { buildPlanGraphModel } from '../src/plan-graph-model.js';

let nextTestId = 0;
function node(name, children = [], metrics = [], overrides = {}) {
  return { id: `t${nextTestId++}`, name, detail: name, metrics, children, ...overrides };
}

// Mirrors resolvePlanTree's real split shape (see event-handlers.ts):
// write keeps metrics/detail='', read keeps detail/metrics=[].
function splitExchange(label, children, { detail = label } = {}) {
  const write = node(label, children, [], { exchangeRole: 'write', detail: '' });
  const read = node(label, [write], [], { exchangeRole: 'read', detail });
  return read;
}

function makeAppModel({ stageId = 1, sqlExecutionId = 1, stageIds = [stageId], planTree, stages = {} } = {}) {
  const stagesMap = new Map();
  for (const id of stageIds) {
    stagesMap.set(id, {
      id,
      sqlExecutionId,
      submittedAt: 0,
      completedAt: 1000,
      ...(stages[id] ?? {}),
    });
  }
  return {
    app: null,
    stages: stagesMap,
    executors: { added: [], removed: [] },
    sql: new Map([[sqlExecutionId, { executionId: sqlExecutionId, planTree, stageIds }]]),
    jobs: new Map(),
    runAggregates: null,
    evidenceAvailability: null,
  };
}

describe('buildPlanGraphModel', () => {
  it('returns an empty model for a null planTree', () => {
    const model = buildPlanGraphModel(null, { scope: 'full', stageId: 1, appModel: makeAppModel({ planTree: null }) });
    expect(model).toEqual({ nodes: [], edges: [], segmentIndex: null, segmentCount: 0, scope: 'full', segmentStageIds: new Map() });
  });

  it('builds one node per plan node and one edge per parent-child link, in full scope', () => {
    const leaf = node('Scan parquet');
    const root = node('SortMergeJoin', [leaf]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    expect(model.scope).toBe('full');
    expect(model.nodes).toHaveLength(2);
    expect(model.edges).toHaveLength(1);
    const rootNode = model.nodes.find((n) => n.label === 'SortMergeJoin');
    const leafNode = model.nodes.find((n) => n.label === 'Scan parquet');
    expect(model.edges[0]).toMatchObject({ source: rootNode.id, target: leafNode.id });
  });

  it('carries every operator metric (formatted) and the full plan detail onto the node', () => {
    const leaf = node(
      'Scan parquet',
      [],
      [
        { name: 'number of output rows', value: 4_100_000 },
        { name: 'scan time', value: 1500, metricType: 'timing' },
      ],
      { detail: 'FileScan parquet db.sales[region#3] Batched: true' },
    );
    const appModel = makeAppModel({ planTree: leaf });

    const model = buildPlanGraphModel(leaf, { scope: 'full', stageId: 1, appModel });
    const n = model.nodes[0];

    expect(n.metrics).toHaveLength(2);
    expect(n.metrics[0]).toEqual({ name: 'number of output rows', value: '4,100,000' });
    expect(n.detailText).toBe('FileScan parquet db.sales[region#3] Batched: true');
  });

  it('leaves detailText empty when the detail just repeats the operator name', () => {
    // node() defaults detail === name, which carries no extra information.
    const leaf = node('Scan parquet');
    const appModel = makeAppModel({ planTree: leaf });
    const model = buildPlanGraphModel(leaf, { scope: 'full', stageId: 1, appModel });
    expect(model.nodes[0].detailText).toBe('');
  });

  it('carries a pre-split Exchange pair through as read/write halves sharing one sourceNodeId', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(readHalf).toBeTruthy();
    expect(writeHalf).toBeTruthy();
    expect(readHalf.sourceNodeId).toBe(writeHalf.sourceNodeId);
    expect(readHalf.sourceNodeId).toBe(readHalf.id);
    expect(model.nodes).toHaveLength(4); // root, exchange-read, exchange-write, leaf
  });

  it('keeps each attributed stage wall-time total in that stage segment', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: { 1: { submittedAt: 0, completedAt: 500 }, 2: { submittedAt: 500, completedAt: 1500 } },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const totalForStage = (stageId) => model.nodes
      .filter((graphNode) => model.segmentStageIds.get(graphNode.segmentIndex) === stageId)
      .reduce((total, graphNode) => total + (graphNode.durationShare ?? 0), 0);
    expect(totalForStage(1)).toBe(500);
    expect(totalForStage(2)).toBe(1000);
  });

  it('routes the parent edge to the read half and the child edge to the write half, with a read->write pairing edge', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const rootNode = model.nodes.find((n) => n.label === 'SortMergeJoin');
    const leafNode = model.nodes.find((n) => n.label === 'Scan parquet');
    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');

    expect(model.edges).toContainEqual(expect.objectContaining({ source: rootNode.id, target: readHalf.id }));
    expect(model.edges).toContainEqual(expect.objectContaining({ source: readHalf.id, target: writeHalf.id }));
    expect(model.edges).toContainEqual(expect.objectContaining({ source: writeHalf.id, target: leafNode.id }));
    expect(model.edges).toHaveLength(3);
  });

  it('weights the read->write exchange edge with the producing stage shuffleWriteBytes, leaving plain edges unweighted', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    // The write half + scan land in the producer segment, which zips to the
    // focus stage (stage 1, submitted earliest); the consumer segment zips to
    // stage 2. So the exchange's bytes come from stage 1's shuffleWriteBytes.
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: {
        1: { submittedAt: 0, completedAt: 500, shuffleWriteBytes: 4096 },
        2: { submittedAt: 500, completedAt: 1000, shuffleReadBytes: 4096 },
      },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    const exchangeEdge = model.edges.find((e) => e.source === readHalf.id && e.target === writeHalf.id);
    expect(exchangeEdge.shuffleBytes).toBe(4096);
    // Ordinary parent-child edges (e.g. parent -> read half) carry no weight.
    const plainEdge = model.edges.find((e) => e.target === readHalf.id);
    expect(plainEdge.shuffleBytes).toBeUndefined();
  });

  it('leaves an exchange edge unweighted when the producing stage wrote no shuffle bytes (broadcast/empty)', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('BroadcastExchange', [leaf]);
    const root = node('BroadcastHashJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: {
        1: { submittedAt: 0, completedAt: 500, shuffleWriteBytes: 0 },
        2: { submittedAt: 500, completedAt: 1000 },
      },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    const exchangeEdge = model.edges.find((e) => e.target === writeHalf.id);
    expect(exchangeEdge.shuffleBytes).toBeUndefined();
  });

  it('cross-links a split Exchange pair via pairedNodeId (each half points at the other)', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(readHalf.pairedNodeId).toBe(writeHalf.id);
    expect(writeHalf.pairedNodeId).toBe(readHalf.id);
  });

  it('leaves pairedNodeId null on ordinary (non-split) nodes', () => {
    const leaf = node('Scan parquet');
    const root = node('SortMergeJoin', [leaf]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    for (const n of model.nodes) expect(n.pairedNodeId ?? null).toBeNull();
  });

  it('keeps pairedNodeId reachable from a single segment even though the partner is scoped out', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: { 1: { submittedAt: 0, completedAt: 500 }, 2: { submittedAt: 500, completedAt: 1000 } },
    });

    const model = buildPlanGraphModel(root, { scope: 'segment', stageId: 1, appModel });

    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(writeHalf.pairedNodeId).toEqual(expect.any(String));
    // The partner read half lives in the consumer segment, not this one.
    expect(model.nodes.some((n) => n.id === writeHalf.pairedNodeId)).toBe(false);
  });

  it('mirrors the shuffle-boundary bytes onto both Exchange halves via exchangeShuffleBytes', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: {
        1: { submittedAt: 0, completedAt: 500, shuffleWriteBytes: 4096 },
        2: { submittedAt: 500, completedAt: 1000, shuffleReadBytes: 4096 },
      },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(writeHalf.exchangeShuffleBytes).toBe(4096);
    expect(readHalf.exchangeShuffleBytes).toBe(4096);
  });

  it('leaves exchangeShuffleBytes null on both halves of a zero-byte (broadcast/empty) exchange', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('BroadcastExchange', [leaf]);
    const root = node('BroadcastHashJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: {
        1: { submittedAt: 0, completedAt: 500, shuffleWriteBytes: 0 },
        2: { submittedAt: 500, completedAt: 1000 },
      },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(writeHalf.exchangeShuffleBytes ?? null).toBeNull();
    expect(readHalf.exchangeShuffleBytes ?? null).toBeNull();
  });

  it('assigns the write half to its producer component and the read half to its consumer component', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const rootNode = model.nodes.find((n) => n.label === 'SortMergeJoin');
    const leafNode = model.nodes.find((n) => n.label === 'Scan parquet');
    const readHalf = model.nodes.find((n) => n.splitRole === 'read');
    const writeHalf = model.nodes.find((n) => n.splitRole === 'write');
    expect(readHalf.segmentIndex).toBe(rootNode.segmentIndex);
    expect(writeHalf.segmentIndex).toBe(leafNode.segmentIndex);
    expect(writeHalf.segmentIndex).not.toBe(readHalf.segmentIndex);
  });

  it('maps sibling Exchange write halves to their distinct producer components', () => {
    const left = node('Scan left');
    const right = node('Scan right');
    const leftExchange = splitExchange('Exchange left', [left]);
    const rightExchange = splitExchange('Exchange right', [right]);
    const root = node('Join', [leftExchange, rightExchange]);
    const appModel = makeAppModel({ planTree: root, stageIds: [1, 2, 3] });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const leftNode = model.nodes.find((n) => n.label === 'Scan left');
    const rightNode = model.nodes.find((n) => n.label === 'Scan right');
    const leftWrite = model.nodes.find((n) => n.label === 'Exchange left' && n.splitRole === 'write');
    const rightWrite = model.nodes.find((n) => n.label === 'Exchange right' && n.splitRole === 'write');
    expect(model.segmentCount).toBe(3);
    expect(leftWrite.segmentIndex).toBe(leftNode.segmentIndex);
    expect(rightWrite.segmentIndex).toBe(rightNode.segmentIndex);
    expect(leftWrite.segmentIndex).not.toBe(rightWrite.segmentIndex);
    expect(model.segmentStageIds.size).toBe(3);
    expect(new Set(model.segmentStageIds.values())).toEqual(new Set([1, 2, 3]));
  });

  it('keeps stage labels and durations aligned to explicit topology in an uneven plan', () => {
    const deep = node('Scan deep');
    const deepExchange = splitExchange('Exchange deep', [deep]);
    const left = node('Project left', [deepExchange]);
    const leftExchange = splitExchange('Exchange left', [left]);
    const right = node('Scan right');
    const rightExchange = splitExchange('Exchange right', [right]);
    const root = node('Join', [leftExchange, rightExchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 10,
      stageIds: [10, 20, 30, 40],
      stages: {
        10: { submittedAt: 0,    completedAt: 200 },
        20: { submittedAt: 200,  completedAt: 500 },
        30: { submittedAt: 500,  completedAt: 1100 },
        40: { submittedAt: 1100, completedAt: 1500 },
      },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 10, appModel });
    const deepNode = model.nodes.find((graphNode) => graphNode.label === 'Scan deep');
    const leftNode = model.nodes.find((graphNode) => graphNode.label === 'Project left');
    const rightNode = model.nodes.find((graphNode) => graphNode.label === 'Scan right');

    expect(model.segmentStageIds.get(deepNode.segmentIndex)).toBe(10);
    expect(deepNode.durationShare).toBe(100);
    expect(model.segmentStageIds.get(leftNode.segmentIndex)).toBe(20);
    expect(leftNode.durationShare).toBe(100);
    expect(model.segmentStageIds.get(rightNode.segmentIndex)).toBe(30);
    expect(rightNode.durationShare).toBe(300);
  });

  it('filters to one segment in scope "segment", dropping edges that cross the boundary', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: { 1: { submittedAt: 0, completedAt: 500 }, 2: { submittedAt: 500, completedAt: 1000 } },
    });

    const model = buildPlanGraphModel(root, { scope: 'segment', stageId: 1, appModel });

    expect(model.scope).toBe('segment');
    expect(model.segmentIndex).toBe(1);
    expect(model.segmentCount).toBe(2);
    expect(model.nodes.map((n) => n.label)).toEqual(['Exchange hashpartitioning', 'Scan parquet']);
    expect(model.edges).toHaveLength(1);
    expect(model.segmentStageIds).toEqual(new Map([[1, 1], [0, 2]]));
  });

  it('falls back to full scope when the stage has no matching segment (segment lookup failure)', () => {
    const leaf = node('Scan parquet');
    const root = node('SortMergeJoin', [leaf]);
    const appModel = makeAppModel({ planTree: root, stageId: 1 });

    const model = buildPlanGraphModel(root, { scope: 'segment', stageId: 99, appModel });

    expect(model.scope).toBe('full');
    expect(model.segmentIndex).toBeNull();
    expect(model.nodes).toHaveLength(2);
    expect(model.segmentStageIds).toEqual(new Map());
  });

  it('exposes segmentStageIds in full scope too, not just segment scope', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({
      planTree: root,
      stageId: 1,
      stageIds: [1, 2],
      stages: { 1: { submittedAt: 0, completedAt: 500 }, 2: { submittedAt: 500, completedAt: 1000 } },
    });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    expect(model.scope).toBe('full');
    expect(model.segmentStageIds).toEqual(new Map([[1, 1], [0, 2]]));
  });

  it('fills segmentStageIds for a segment past the Math.min(segments, stages) truncation from its nearest paired neighbor', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root, stageId: 1, stageIds: [1] });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    expect(model.segmentStageIds).toEqual(new Map([[1, 1], [0, 1]]));
  });

  it('leaves durationShare null (never 0) for a segment past the Math.min(segments, stages) truncation', () => {
    const leaf = node('Scan parquet');
    const exchange = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const appModel = makeAppModel({ planTree: root, stageId: 1, stageIds: [1] });

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel });

    const rootNode = model.nodes.find((n) => n.label === 'SortMergeJoin');
    expect(rootNode.durationShare).toBeNull();
  });

  it('attaches a finding to the graph node(s) named in its planNodeIds', () => {
    const leaf = node('Scan parquet');
    const root = node('SortMergeJoin', [leaf]);
    const appModel = makeAppModel({ planTree: root });
    const finding = { type: 'smallFiles', stageIds: [1], impactBand: 'warning', planNodeIds: [leaf.id], executionId: 1 };

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel, findings: [finding] });

    const leafNode = model.nodes.find((n) => n.label === 'Scan parquet');
    const rootNode = model.nodes.find((n) => n.label === 'SortMergeJoin');
    expect(leafNode.findings).toEqual([finding]);
    expect(rootNode.findings).toEqual([]);
  });

  it('drops a finding whose planNodeIds are not in the current scope, without throwing', () => {
    const leaf = node('Scan parquet');
    const root = node('SortMergeJoin', [leaf]);
    const appModel = makeAppModel({ planTree: root });
    const finding = { type: 'smallFiles', stageIds: [1], impactBand: 'warning', planNodeIds: ['not-in-this-tree'], executionId: 1 };

    const model = buildPlanGraphModel(root, { scope: 'full', stageId: 1, appModel, findings: [finding] });
    expect(model.nodes.every((n) => n.findings.length === 0)).toBe(true);
  });

  it('does not attach a finding from a different SQL execution, even when its planNodeIds collide with the current tree (node ids are only unique per execution)', () => {
    // resolvePlanTree resets its `n0, n1, ...` id counter on every call, so
    // two independent SQL executions' plan trees can both legitimately
    // contain a node literally named "n1". A finding tagged with the WRONG
    // execution's id must not badge onto this tree's same-named node.
    const leafExecA = node('Scan parquet', [], [], { id: 'n1' });
    const rootExecA = node('SortMergeJoin', [leafExecA], [], { id: 'n0' });
    const leafExecB = node('Scan parquet', [], [], { id: 'n1' });
    const rootExecB = node('SortMergeJoin', [leafExecB], [], { id: 'n0' });

    const appModel = {
      app: null,
      stages: new Map([
        [10, { id: 10, sqlExecutionId: 1, submittedAt: 0, completedAt: 1000 }],
        [20, { id: 20, sqlExecutionId: 2, submittedAt: 0, completedAt: 1000 }],
      ]),
      executors: { added: [], removed: [] },
      sql: new Map([
        [1, { executionId: 1, planTree: rootExecA, stageIds: [10] }],
        [2, { executionId: 2, planTree: rootExecB, stageIds: [20] }],
      ]),
      jobs: new Map(),
      runAggregates: null,
      evidenceAvailability: null,
    };
    // Belongs to execution 1's node n1 only.
    const finding = { type: 'smallFiles', stageIds: [10], impactBand: 'warning', planNodeIds: ['n1'], executionId: 1 };

    const modelExecB = buildPlanGraphModel(rootExecB, { scope: 'full', stageId: 20, appModel, findings: [finding] });
    const n1InExecB = modelExecB.nodes.find((n) => n.id === 'n1');
    expect(n1InExecB.findings).toEqual([]);

    const modelExecA = buildPlanGraphModel(rootExecA, { scope: 'full', stageId: 10, appModel, findings: [finding] });
    const n1InExecA = modelExecA.nodes.find((n) => n.id === 'n1');
    expect(n1InExecA.findings).toEqual([finding]);
  });
});

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const stage394Fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/plan-graph-stage-394.json'), 'utf-8'));

describe('buildPlanGraphModel (stage-394 regression fixture)', () => {
  function appModelFromFixture(fixture) {
    return {
      app: null,
      stages: new Map([[fixture.stageId, {
        id: fixture.stageId,
        sqlExecutionId: fixture.sqlExecutionId,
        submittedAt: fixture.stage.submittedAt,
        completedAt: fixture.stage.completedAt,
      }]]),
      executors: { added: [], removed: [] },
      sql: new Map([[fixture.sqlExecutionId, {
        executionId: fixture.sqlExecutionId,
        planTree: fixture.planTree,
        stageIds: fixture.sqlExec.stageIds,
      }]]),
      jobs: new Map(),
      runAggregates: null,
      evidenceAvailability: null,
    };
  }

  it('pins the segment-scoped node/edge counts for this stage', () => {
    const appModel = appModelFromFixture(stage394Fixture);
    const model = buildPlanGraphModel(stage394Fixture.planTree, {
      scope: 'segment',
      stageId: stage394Fixture.stageId,
      appModel,
    });

    expect(model.nodes.length).toBeGreaterThan(0);
    expect(model.segmentCount).toBe(165);
  });
});
