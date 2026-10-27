import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { analyze } from '../src/analyzer.js';
import { collectRun } from '../src/cli/collect-run.js';
import { joinKeyCastOf } from '../src/join-key-cast.js';
import { parseJoinKeys, partitioningArgs, summarizePlanTree } from '../src/plan-summary.js';
import { makeApp, makeStage } from './fixtures/stage-app-fixtures.js';

// A decimal(18,0) column joined to a bigint column, then a window over the decimal column, run on
// Spark 3.5.3 in local mode with auto-broadcast and AQE off, and cut down for the repo.
const SPIKE_LOG = fileURLToPath(new URL('./fixtures/join-key-cast-spark-3.5.3.ndjson', import.meta.url));

const node = (name, detail, children = [], extra = {}) => ({ id: `${name}-${detail}`, name, detail, children, stageIds: [1], ...extra });
// A split Exchange: the read half over its write half, which carries the data size.
const exchange = (detail, child, bytes = 4096) => node('Exchange', `Exchange ${detail}, ENSURE_REQUIREMENTS`, [
  node('Exchange', '', [child], { exchangeRole: 'write', metrics: [{ name: 'data size', value: bytes }] }),
], { exchangeRole: 'read' });
const scan = (name) => node('Scan', name);

const DECIMAL_JOIN = 'SortMergeJoin [cast(k#2 as decimal(20,0))], [cast(k#8L as decimal(20,0))], Inner';

const joinOf = (detail) => node(detail.split(' ')[0], detail, [scan('a'), scan('b')]);

function parentsOf(root) {
  const parents = new Map();
  const visit = (n, parent) => { parents.set(n, parent); n.children.forEach((c) => visit(c, n)); };
  visit(root, null);
  return parents;
}

function castOf(root) {
  const parents = parentsOf(root);
  const join = [...parents.keys()].find((n) => /Join/.test(n.name));
  return joinKeyCastOf(join, parents);
}

describe('partitioningArgs', () => {
  it('keeps a decimal cast key whole and reads the partition count after it', () => {
    expect(partitioningArgs('Exchange hashpartitioning(cast(k#2 as decimal(20,0)), a#1, 4), ENSURE_REQUIREMENTS', 'hash'))
      .toEqual({ keys: ['cast(k#2 as decimal(20,0))', 'a#1'], numPartitions: 4 });
  });

  it('reads a range partitioning and ignores a detail with neither', () => {
    expect(partitioningArgs('Exchange rangepartitioning(a#1 ASC NULLS FIRST, 200)', 'range'))
      .toEqual({ keys: ['a#1 ASC NULLS FIRST'], numPartitions: 200 });
    expect(partitioningArgs('Exchange SinglePartition', 'hash')).toBeNull();
  });

  it('feeds the exchange rows of the plan summary', () => {
    const tree = exchange('hashpartitioning(cast(k#2 as decimal(20,0)), 4)', scan('a'));
    expect(summarizePlanTree(tree).exchanges).toEqual([
      { partitioning: 'hash', keys: ['cast(k#2 as decimal(20,0))'], numPartitions: 4 },
    ]);
  });
});

describe('parseJoinKeys', () => {
  it('splits keys that hold commas and keeps expression ids', () => {
    expect(parseJoinKeys(DECIMAL_JOIN)).toEqual({
      operator: 'SortMergeJoin',
      leftKeys: ['cast(k#2 as decimal(20,0))'],
      rightKeys: ['cast(k#8L as decimal(20,0))'],
      joinType: 'Inner',
    });
  });

  it('ignores a line that is not a keyed join', () => {
    expect(parseJoinKeys('Sort [a#1 ASC NULLS FIRST], false, 0')).toBeNull();
  });
});

describe('joinKeyCastOf', () => {
  const window = (child) => node('Window', 'Window [row_number()]', [node('Sort', 'Sort [k#2 ASC]', [child])]);

  it('names the cast keys and the exchange that shuffles by the uncast column', () => {
    const root = window(exchange('hashpartitioning(k#2, 4)', node('Project', 'Project [k#2]', [joinOf(DECIMAL_JOIN)])));
    const found = castOf(root);
    expect(found).toMatchObject({ operator: 'SortMergeJoin', castKeys: ['cast(k as decimal(20,0))'], exchangeKeys: ['k'] });
    expect(found.exchange.exchangeRole).toBe('read');
  });

  it('finds the exchange after a partial aggregate', () => {
    const partial = node('HashAggregate', 'HashAggregate(keys=[k#2], functions=[partial_count(1)])', [joinOf(DECIMAL_JOIN)]);
    expect(castOf(exchange('hashpartitioning(k#2, 4)', partial))).not.toBeNull();
  });

  it('reports a cast on one side only', () => {
    const root = exchange('hashpartitioning(a#1, 4)', joinOf('SortMergeJoin [cast(a#1 as bigint)], [b#2L], Inner'));
    expect(castOf(root)).toMatchObject({ castKeys: ['cast(a as bigint)'], exchangeKeys: ['a'] });
  });

  it('reports nothing when the next exchange shuffles by the cast expression itself', () => {
    expect(castOf(exchange('hashpartitioning(cast(k#2 as decimal(20,0)), 4)', joinOf(DECIMAL_JOIN)))).toBeNull();
  });

  it('reports nothing when no exchange follows the join', () => {
    expect(castOf(window(joinOf(DECIMAL_JOIN)))).toBeNull();
  });

  it('reports nothing when a window or another join consumes the join output before any exchange', () => {
    const behindWindow = exchange('hashpartitioning(k#2, 4)', window(joinOf(DECIMAL_JOIN)));
    expect(castOf(behindWindow)).toBeNull();
  });

  it('reports nothing for an uncast key, a broadcast join or an exchange on another column', () => {
    expect(castOf(exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [k#2L], [k#8L], Inner')))).toBeNull();
    expect(castOf(exchange('hashpartitioning(k#2, 4)', joinOf('BroadcastHashJoin [cast(k#2 as bigint)], [k#8L], Inner, BuildRight')))).toBeNull();
    expect(castOf(exchange('hashpartitioning(v#3L, 4)', joinOf(DECIMAL_JOIN)))).toBeNull();
  });

  it('reports nothing when another key of the join keeps the exchange without the cast', () => {
    const multiKey = joinOf('SortMergeJoin [cast(a#1 as decimal(20,0)), d#4], [x#7, y#8], Inner');
    expect(castOf(exchange('hashpartitioning(a#1, 4)', multiKey))).toBeNull();
  });

  it('reports a multi-key join when the exchange covers every key of the cast side', () => {
    const multiKey = joinOf('SortMergeJoin [cast(a#1 as decimal(20,0)), d#4], [x#7, y#8], Inner');
    expect(castOf(exchange('hashpartitioning(d#4, a#1, 4)', multiKey))).toMatchObject({ exchangeKeys: ['a'] });
  });

  it('reports nothing when the join type does not keep the cast side partitioning', () => {
    expect(castOf(exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [cast(k#2 as decimal(20,0))], [k#8L], FullOuter')))).toBeNull();
    expect(castOf(exchange('hashpartitioning(k#8L, 4)', joinOf('SortMergeJoin [k#2L], [cast(k#8L as bigint)], LeftOuter')))).toBeNull();
    expect(castOf(exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [cast(k#2 as bigint)], [k#8L], RightOuter')))).toBeNull();
  });

  it('reports a cast on the side an outer join keeps', () => {
    expect(castOf(exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [cast(k#2 as bigint)], [k#8L], LeftOuter')))).toMatchObject({ exchangeKeys: ['k'] });
    expect(castOf(exchange('hashpartitioning(k#8L, 4)', joinOf('ShuffledHashJoin [k#2L], [cast(k#8L as bigint)], RightOuter, BuildLeft')))).toMatchObject({ exchangeKeys: ['k'] });
  });

  it('reports nothing for an exchange the job asked for', () => {
    const repartition = node('Exchange', 'Exchange hashpartitioning(k#2, 4), REPARTITION_BY_COL', [
      node('Exchange', '', [joinOf(DECIMAL_JOIN)], { exchangeRole: 'write' }),
    ], { exchangeRole: 'read' });
    expect(castOf(repartition)).toBeNull();
  });
});

describe('joinKeyCast finding', () => {
  function findingsFor(planTree) {
    const sql = new Map([[1, { id: 1, description: '', startTime: 0, endTime: 100, stageIds: [], planTree }]]);
    const stages = new Map([[1, makeStage({ sqlExecutionId: 1, completedAt: 10_000, taskActiveMs: 10_000 })]]);
    return analyze(makeApp({ endTime: 10_000 }), stages, [], [], new Map(), sql).filter((f) => f.type === 'joinKeyCast');
  }

  it('is an info finding that carries the keys, the shuffle size and the advice', () => {
    const tree = exchange('hashpartitioning(k#2, 4)', joinOf(DECIMAL_JOIN), 2048);
    const [f] = findingsFor(tree);
    expect(f).toMatchObject({
      type: 'joinKeyCast', executionId: 1, impactBand: 'info', metric: 'shuffleBytes', value: 2048,
      nodeName: 'SortMergeJoin', castKeys: ['cast(k as decimal(20,0))'], exchangeKeys: ['k'],
    });
    expect(f.recommendation).toContain('cast(k as decimal(20,0))');
    expect(f.recommendation).toContain('same type');
    expect(f.remediation).toEqual([{ kind: 'code', hint: expect.stringContaining('same type') }]);
  });

  it('reports each cast join once', () => {
    const second = exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [cast(k#2 as bigint)], [k#8L], Inner'), 1);
    const first = exchange('hashpartitioning(k#2, 4)', joinOf(DECIMAL_JOIN), 2);
    expect(findingsFor(node('Union', 'Union', [first, second]))).toHaveLength(2);
  });

  it('keeps two cast joins of one operator apart when their exchanges report no size', () => {
    const second = exchange('hashpartitioning(k#2, 4)', joinOf('SortMergeJoin [cast(k#2 as bigint)], [k#8L], Inner'), 0);
    const first = exchange('hashpartitioning(k#2, 4)', joinOf(DECIMAL_JOIN), 0);
    const findings = findingsFor(node('Union', 'Union', [first, second]));
    expect(findings).toHaveLength(2);
    expect(new Set(findings.map((f) => f.id)).size).toBe(2);
  });
});

describe('joinKeyCast on a local Spark run', () => {
  it('flags the decimal-to-bigint join and the window that shuffles again', async () => {
    const { appModel } = await collectRun(SPIKE_LOG);
    const findings = analyze(
      appModel.app, appModel.stages, appModel.executors.added, appModel.executors.removed,
      appModel.jobs, appModel.sql, appModel.runAggregates,
    ).filter((f) => f.type === 'joinKeyCast');
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      impactBand: 'info', nodeName: 'SortMergeJoin', castKeys: ['cast(k as decimal(20,0))'], exchangeKeys: ['k'],
    });
    expect(findings[0].value).toBeGreaterThan(0);
  });
});
