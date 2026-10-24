import { describe, it, expect } from 'vitest';
import { analyze } from '../src/analyzer.js';
import { recommendationParts } from '../src/finding-names.js';
import { attributeSpill, describeSpillCause, exchangeWidth, spillToInputRatio } from '../src/spill-attribution.js';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

const TB = 1e12;
const GB = 1e9;

const sized = (name, value) => ({ name, value, metricType: 'size', executorSide: true });
const count = (name, value) => ({ name, value, metricType: 'sum', executorSide: true });
const node = (id, name, detail, children = [], { metrics = [], stageIds, exchangeRole } = {}) =>
  ({ id, name, detail, metrics, children, ...(stageIds ? { stageIds } : {}), ...(exchangeRole ? { exchangeRole } : {}) });

// "c0#1, c1#2, ..." as Spark prints a list past spark.sql.debug.maxToStringFields (25).
function truncatedColumns(total, shown = 25) {
  const listed = Array.from({ length: shown }, (_, i) => `c${i}#${i + 1}`);
  return `[${listed.join(', ')}, ... ${total - shown} more fields]`;
}

function exchange(id, below, { producer = 1, dataSize, records } = {}) {
  const metrics = [
    ...(dataSize != null ? [sized('data size', dataSize)] : []),
    ...(records != null ? [count('shuffle records written', records)] : []),
  ];
  const write = node(`${id}w`, 'Exchange', '', [below], { metrics, stageIds: [producer], exchangeRole: 'write' });
  return node(id, 'Exchange', 'Exchange hashpartitioning(k#1, 200), ENSURE_REQUIREMENTS, [plan_id=5]', [write], { stageIds: [producer], exchangeRole: 'read' });
}

const wideProject = (columns) => node('proj', 'Project', `Project ${truncatedColumns(columns)}`, [node('scan', 'Scan parquet db.t', 'FileScan parquet db.t[k#1] Batched: true')]);

function wideSortPlan({ spill = 3 * TB } = {}) {
  const sort = node('sort', 'Sort', 'Sort [k#1 ASC NULLS FIRST], false, 0',
    [node('adapter', 'InputAdapter', '', [exchange('xchg', wideProject(128), { dataSize: 410 * GB, records: 1e9 })])],
    { metrics: [sized('spill size', spill), sized('sort time', 5)], stageIds: [2] });
  return node('write', 'WriteFiles', 'WriteFiles', [node('wscg', 'WholeStageCodegen (4)', 'WholeStageCodegen (4)', [sort], { stageIds: [2] })]);
}

function spillFinding(planTree, stageOverrides = {}) {
  const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree }]]);
  const stages = new Map([[2, makeStage({
    id: 2, sqlExecutionId: 1, memoryBytesSpilled: 67.7 * TB, diskBytesSpilled: 20 * TB, shuffleReadBytes: 4 * TB,
    spillClassification: 'volume', spillMemMax: 5 * GB, spillDiskMax: 2 * GB, ...stageOverrides,
  })]]);
  return analyze(makeApp(), stages, [], [], new Map(), sql).find((f) => f.type === 'spill');
}

describe('attributeSpill', () => {
  it('names the sort that spilled with its plan node id and reported spill', () => {
    const { operators } = attributeSpill(wideSortPlan(), 2);
    expect(operators).toEqual([{ nodeId: 'sort', name: 'Sort', spillBytes: 3 * TB }]);
  });

  // As an executed plan prints it: each Sort sits in its own codegen stage under an InputAdapter.
  const sortMergeJoin = (name) => {
    const side = (id, spill, below) => node('in-' + id, 'InputAdapter', '', [node('wscg-' + id, 'WholeStageCodegen (3)', 'WholeStageCodegen (3)', [
      node(id, 'Sort', 'Sort [k#1 ASC NULLS FIRST], false, 0', [below], { metrics: [sized('spill size', spill)], stageIds: [2] }),
    ], { stageIds: [2] })], { stageIds: [2] });
    return node('smj', name, `${name} [k#1], [k#2], Inner`, [
      side('left', 10 * GB, exchange('xl', wideProject(91), { dataSize: 91 * GB, records: 1e8 })),
      side('right', 24.2 * TB, exchange('xr', wideProject(91), { dataSize: 91 * GB, records: 1e8 })),
    ], { stageIds: [2] });
  };

  it.each(['SortMergeJoin', 'SortMergeJoin(skew=true)'])('names both sorts feeding a %s through its codegen wrappers, largest spill first, and leaves out an operator that did not spill', (name) => {
    const idle = node('agg', 'HashAggregate', 'HashAggregate(keys=[k#1], functions=[count(1)])', [sortMergeJoin(name)], { metrics: [sized('spill size', 0)], stageIds: [2] });
    const { operators } = attributeSpill(idle, 2);
    expect(operators).toEqual([
      { nodeId: 'right', name: 'Sort', spillBytes: 24.2 * TB, feeds: 'SortMergeJoin' },
      { nodeId: 'left', name: 'Sort', spillBytes: 10 * GB, feeds: 'SortMergeJoin' },
    ]);
  });

  it('does not mark a sort as feeding a join it only sits below through other operators', () => {
    const sort = node('sort', 'Sort', 'Sort [k#1 ASC NULLS FIRST], false, 0', [], { metrics: [sized('spill size', GB)], stageIds: [2] });
    const join = node('smj', 'SortMergeJoin', 'SortMergeJoin [k#1], [k#2], Inner', [node('f', 'Filter', 'Filter (k#1 > 0)', [sort])]);
    expect(attributeSpill(join, 2).operators).toEqual([{ nodeId: 'sort', name: 'Sort', spillBytes: GB }]);
  });

  it('names a hash aggregate that spilled', () => {
    const agg = node('agg', 'HashAggregate', 'HashAggregate(keys=[k#1], functions=[sum(v#2)])', [], { metrics: [sized('spill size', 2 * GB)], stageIds: [2] });
    expect(attributeSpill(agg, 2).operators).toEqual([{ nodeId: 'agg', name: 'HashAggregate', spillBytes: 2 * GB }]);
  });

  it('names no operator when the plan reports no spill size', () => {
    const plan = node('agg', 'HashAggregate', 'HashAggregate(keys=[k#1], functions=[count(1)])', [
      node('sort', 'Sort', 'Sort [k#1 ASC NULLS FIRST], false, 0', [], { stageIds: [2] }),
    ], { stageIds: [2] });
    expect(attributeSpill(plan, 2)).toEqual({ operators: [], exchanges: [] });
  });

  it('ignores operators of other stages and plans without stage ids', () => {
    const plan = node('sort', 'Sort', 'Sort [k#1 ASC NULLS FIRST], false, 0', [], { metrics: [sized('spill size', GB)], stageIds: [7] });
    expect(attributeSpill(plan, 2)).toEqual({ operators: [], exchanges: [] });
    expect(attributeSpill(node('sort', 'Sort', '', []), 2)).toEqual({ operators: [], exchanges: [] });
    expect(attributeSpill(null, 2)).toEqual({ operators: [], exchanges: [] });
  });

  it('keeps five operators at most', () => {
    const sorts = Array.from({ length: 8 }, (_, i) => node(`s${i}`, 'Sort', '', [], { metrics: [sized('spill size', (i + 1) * GB)], stageIds: [2] }));
    const { operators } = attributeSpill(node('root', 'Union', 'Union', sorts), 2);
    expect(operators.map((op) => op.nodeId)).toEqual(['s7', 's6', 's5', 's4', 's3']);
  });

  it('reports the exchange a spilling sort reads once, however many operators read it', () => {
    const shared = exchange('xchg', wideProject(40), { dataSize: 40 * GB, records: 1e8 });
    const sort = node('sort', 'Sort', '', [shared], { metrics: [sized('spill size', GB)], stageIds: [2] });
    const window = node('window', 'Window', 'Window [rank() ...]', [sort], { metrics: [sized('spill size', GB)], stageIds: [2] });
    const { operators, exchanges } = attributeSpill(window, 2);
    expect(operators.map((op) => op.nodeId)).toEqual(['window', 'sort']);
    expect(exchanges).toEqual([{ nodeId: 'xchg', columns: 40, bytesPerRow: 400 }]);
  });
});

describe('exchangeWidth', () => {
  it('counts the columns of a truncated Project list and divides data size by records written', () => {
    const x = exchange('xchg', wideProject(128), { dataSize: 410 * GB, records: 1e9 });
    expect(exchangeWidth(x)).toEqual({ columns: 128, bytesPerRow: 410 });
  });

  it('counts a Project list that fits without a truncation tail, skipping commas inside expressions', () => {
    const project = node('p', 'Project', 'Project [k#1, concat(a#2, b#3) AS ab#4, named_struct(x, c#5, y, d#6) AS s#7]');
    expect(exchangeWidth(exchange('x', project)).columns).toBe(3);
  });

  it('reads the columns from a file scan below filters and sorts', () => {
    const scan = node('scan', 'Scan parquet db.t', 'FileScan parquet db.t[a#1,b#2,c#3] Batched: true, Format: Parquet, ReadSchema: struct<a:int,b:int,c:int>');
    const below = node('f', 'Filter', 'Filter (a#1 > 0)', [node('s', 'Sort', 'Sort [a#1 ASC], false, 0', [scan])]);
    expect(exchangeWidth(exchange('x', below)).columns).toBe(3);
  });

  it('reads the columns of a ReusedExchange from its own list', () => {
    const reused = node('r', 'ReusedExchange', 'ReusedExchange [k#1L, d#5], Exchange hashpartitioning(k#1L, 8), ENSURE_REQUIREMENTS, [plan_id=40]');
    expect(exchangeWidth(reused)).toEqual({ columns: 2 });
  });

  it('reports only bytes per row where the plan below lists no columns', () => {
    const join = node('j', 'SortMergeJoin', 'SortMergeJoin [k#1], [k#2], Inner', [node('a', 'Scan', ''), node('b', 'Scan', '')]);
    expect(exchangeWidth(exchange('x', join, { dataSize: 10 * GB, records: 1e7 }))).toEqual({ bytesPerRow: 1000 });
  });

  it('reports only the column count where the exchange has no row count', () => {
    expect(exchangeWidth(exchange('x', wideProject(60), { dataSize: GB }))).toEqual({ columns: 60 });
    expect(exchangeWidth(exchange('x', wideProject(60), { dataSize: GB, records: 0 }))).toEqual({ columns: 60 });
  });

  it('reports nothing for an exchange it can read neither figure from, or a list whose brackets do not balance', () => {
    const join = node('j', 'SortMergeJoin', 'SortMergeJoin [k#1], [k#2], Inner', []);
    expect(exchangeWidth(exchange('x', join))).toBeNull();
    const broken = node('p', 'Project', 'Project [concat(a#1, () AS b#2]');
    expect(exchangeWidth(exchange('x', broken))).toBeNull();
  });
});

describe('spillToInputRatio', () => {
  const floor = 64 * 1024 * 1024;

  it('divides memory spill by input plus shuffle read, to one decimal', () => {
    expect(spillToInputRatio(67.7 * TB, 0, 4 * TB, floor)).toBe(16.9);
    expect(spillToInputRatio(30 * GB, 10 * GB, 20 * GB, floor)).toBe(1);
  });

  it('is null for a stage that reads nothing, or less than the floor', () => {
    expect(spillToInputRatio(GB, 0, 0, floor)).toBeNull();
    expect(spillToInputRatio(GB, 150_000, 0, floor)).toBeNull();
    expect(spillToInputRatio(GB, 0, 0, 0)).toBeNull();
  });
});

describe('describeSpillCause', () => {
  const sort = { nodeId: 'e1:n12', name: 'Sort', spillBytes: 3 * GB };

  it('says a high ratio on a scan stage can also come from compressed input files', () => {
    expect(describeSpillCause([], 12, true, true)).toBe("Memory spill is 12x the stage's input, so the rows are wide or the input files compress well, as Parquet does.");
    expect(describeSpillCause([], 4, false, true)).toBe("Memory spill is 4x the stage's input.");
  });

  it('says the rows are wide from a ratio of 10 up, and only reports the ratio below it', () => {
    expect(describeSpillCause([], 10, true, false)).toBe("Memory spill is 10x the stage's input, so the rows are wide.");
    expect(describeSpillCause([], 9.9, false, false)).toBe("Memory spill is 9.9x the stage's input.");
  });

  it('names the operators with their node ids and reported spill', () => {
    expect(describeSpillCause([sort, { nodeId: 'e1:n20', name: 'Sort', spillBytes: GB, feeds: 'SortMergeJoin' }], null, false, false))
      .toBe('Spilled by Sort e1:n12 3.0 GB, Sort e1:n20 feeding SortMergeJoin 1.0 GB.');
  });

  it('is empty with no operator and no ratio', () => {
    expect(describeSpillCause([], null, false, false)).toBe('');
  });
});

describe('spill finding', () => {
  it('names the operator, shows the ratio and says the rows are wide, with the exchange width in evidence', () => {
    const finding = spillFinding(wideSortPlan());
    expect(finding.operators).toEqual([{ nodeId: 'sort', name: 'Sort', spillBytes: 3 * TB }]);
    expect(finding.exchanges).toEqual([{ nodeId: 'xchg', columns: 128, bytesPerRow: 410 }]);
    expect(finding.spillToInputRatio).toBe(16.9);
    expect(finding.wideRows).toBe(true);
    expect(finding.recommendation).toContain('Spilled by Sort sort 3000.0 GB.');
    expect(finding.recommendation).toContain("Memory spill is 16.9x the stage's input, so the rows are wide.");
  });

  it('keeps the recommendation split on its advice, with the cause after it', () => {
    const recommendation = spillFinding(wideSortPlan()).recommendation;
    const advice = recommendation.slice(0, recommendation.indexOf(' Spilled by '));
    const { measured, fix } = recommendationParts(recommendation);
    expect(measured).toBe(recommendationParts(advice).measured);
    expect(fix).toBe(`${recommendationParts(advice).fix} Spilled by Sort sort 3000.0 GB. Memory spill is 16.9x the stage's input, so the rows are wide.`);
  });

  it('keeps the existing advice and does not call rows wide below a 10x ratio', () => {
    const finding = spillFinding(wideSortPlan(), { memoryBytesSpilled: 8 * TB });
    expect(finding.spillToInputRatio).toBe(2);
    expect(finding.wideRows).toBe(false);
    expect(finding.recommendation).toMatch(/^\S+ GB spilled: /);
    expect(finding.recommendation).not.toContain('wide');
  });

  it('reports no ratio, and does not call rows wide, for a stage whose input is under 64 MB', () => {
    const finding = spillFinding(wideSortPlan(), { memoryBytesSpilled: 1.5 * GB, shuffleReadBytes: 0, inputBytes: 150_000 });
    expect(finding).not.toHaveProperty('spillToInputRatio');
    expect(finding).not.toHaveProperty('wideRows');
    expect(finding.recommendation).not.toContain('wide');
  });

  it('carries no ratio, operators or exchanges for a stage with no plan and no input', () => {
    const finding = spillFinding(null, { shuffleReadBytes: 0, inputBytes: 0 });
    expect(finding).not.toHaveProperty('spillToInputRatio');
    expect(finding).not.toHaveProperty('wideRows');
    expect(finding).not.toHaveProperty('operators');
    expect(finding).not.toHaveProperty('exchanges');
  });
});
