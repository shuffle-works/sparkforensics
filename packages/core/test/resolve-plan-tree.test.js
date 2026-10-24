import { describe, it, expect } from 'vitest';
import { resolvePlanTree } from '../src/event-handlers.js';

function rawNode(nodeName, children = [], opts = {}) {
  return {
    nodeName,
    simpleString: opts.detail ?? nodeName,
    metrics: opts.metrics ?? [],
    children,
  };
}

describe('resolvePlanTree: node identity', () => {
  it('assigns a unique id to every node', () => {
    const leaf = rawNode('Scan parquet t');
    const join = rawNode('SortMergeJoin', [leaf, rawNode('Scan parquet u')]);
    const tree = resolvePlanTree(join, new Map(), new Map(), undefined);

    const ids = [];
    (function collect(node) { ids.push(node.id); node.children.forEach(collect); })(tree);
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('produces the same ids on repeated invocations of the same input', () => {
    const leaf = rawNode('Scan parquet t');
    const join = rawNode('SortMergeJoin', [leaf, rawNode('Scan parquet u')]);
    const first = resolvePlanTree(join, new Map(), new Map(), undefined);
    const second = resolvePlanTree(join, new Map(), new Map(), undefined);

    const idsOf = (root) => {
      const ids = [];
      (function collect(node) { ids.push(node.id); node.children.forEach(collect); })(root);
      return ids;
    };
    expect(idsOf(first)).toEqual(idsOf(second));
  });
});

describe('resolvePlanTree: Exchange split', () => {
  it('splits an Exchange node into a read half wrapping a write half', () => {
    const scan = rawNode('Scan parquet t');
    const exchange = rawNode('Exchange', [scan], {
      detail: 'Exchange hashpartitioning(id#1, 200)',
      metrics: [{ name: 'data size', accumulatorId: 1, metricType: 'sum' }],
    });
    const root = rawNode('Project', [exchange]);
    const accumMap = new Map([[1, 12345]]);

    const tree = resolvePlanTree(root, accumMap, new Map(), undefined);

    const read = tree.children[0];
    expect(read.exchangeRole).toBe('read');
    expect(read.name).toBe('Exchange');
    expect(read.detail).toBe('Exchange hashpartitioning(id#1, 200)');
    expect(read.metrics).toEqual([]);
    expect(read.children).toHaveLength(1);

    const write = read.children[0];
    expect(write.exchangeRole).toBe('write');
    expect(write.name).toBe('Exchange');
    expect(write.detail).toBe('');
    expect(write.metrics).toEqual([{ name: 'data size', value: 12345, metricType: 'sum' }]);
    expect(write.children).toHaveLength(1);
    expect(write.children[0].name).toBe('Scan parquet t');

    expect(read.id).not.toBe(write.id);
  });

  it('splits BroadcastExchange the same way', () => {
    const scan = rawNode('Scan parquet t');
    const exchange = rawNode('BroadcastExchange', [scan]);
    const tree = resolvePlanTree(exchange, new Map(), new Map(), undefined);
    expect(tree.exchangeRole).toBe('read');
    expect(tree.children[0].exchangeRole).toBe('write');
  });

  it('duplicates the raw node stageIds onto both halves', () => {
    const scan = rawNode('Scan parquet t');
    const exchange = rawNode('Exchange', [scan], {
      metrics: [{ name: 'data size', accumulatorId: 1 }],
    });
    const accumMap = new Map([[1, 999]]);
    const taskAccumStages = new Map([[1, new Set([7])]]);
    const executionStageIds = new Set([7]);

    const read = resolvePlanTree(exchange, accumMap, taskAccumStages, executionStageIds);
    expect(read.stageIds).toEqual([7]);
    expect(read.children[0].stageIds).toEqual([7]);
  });

  it('does not split ReusedExchange', () => {
    const original = rawNode('Exchange', [rawNode('Scan parquet t')]);
    const reused = rawNode('ReusedExchange', [original]);
    const tree = resolvePlanTree(reused, new Map(), new Map(), undefined);
    expect(tree.name).toBe('ReusedExchange');
    expect(tree.exchangeRole).toBeUndefined();
  });

  it('assigns ids consistently across repeated invocations of a tree containing a split', () => {
    const exchange = rawNode('Exchange', [rawNode('Scan parquet t')]);
    const root = rawNode('Project', [exchange]);
    const idsOf = (r) => {
      const ids = [];
      (function collect(n) { ids.push(n.id); n.children.forEach(collect); })(r);
      return ids;
    };
    const first = resolvePlanTree(root, new Map(), new Map(), undefined);
    const second = resolvePlanTree(root, new Map(), new Map(), undefined);
    expect(idsOf(first)).toEqual(idsOf(second));
  });

  it('prefixes ids with the owning SQL execution so two executions never produce the same id', () => {
    // Without an executionId, nextId resets to 0 on every call, so two
    // executions' identical trees would otherwise both contain a node
    // literally named "n0"/"n1" and a finding could badge the wrong tree
    // (see plan-graph-model.ts's findings guard).
    const leaf = rawNode('Scan parquet t');
    const join = rawNode('SortMergeJoin', [leaf, rawNode('Scan parquet u')]);
    const idsOf = (root) => {
      const ids = [];
      (function collect(n) { ids.push(n.id); n.children.forEach(collect); })(root);
      return ids;
    };
    const execA = resolvePlanTree(join, new Map(), new Map(), undefined, 1);
    const execB = resolvePlanTree(join, new Map(), new Map(), undefined, 2);

    const idsA = idsOf(execA);
    const idsB = idsOf(execB);
    expect(idsA.some((id) => idsB.includes(id))).toBe(false);
  });
});

describe('resolvePlanTree: exchange row width', () => {
  const metric = (name, accumulatorId) => ({ name, accumulatorId, metricType: 'sum' });

  it('puts the width of every exchange, not only spilling ones, on both halves', () => {
    const project = rawNode('Project', [rawNode('Scan parquet t')], { detail: 'Project [a#1, b#2, c#3]' });
    const exchange = rawNode('Exchange', [project], {
      metrics: [metric('data size', 1), metric('shuffle records written', 2)],
    });
    const tree = resolvePlanTree(rawNode('Sort', [exchange]), new Map([[1, 3000], [2, 100]]), new Map(), undefined);

    const read = tree.children[0];
    expect(read.rowWidth).toEqual({ columns: 3, bytesPerRow: 30 });
    expect(read.children[0].rowWidth).toBe(read.rowWidth);
    expect(tree.rowWidth).toBeUndefined();
  });

  it('leaves out the width of an exchange whose rows are unknown', () => {
    const join = rawNode('SortMergeJoin', [rawNode('Scan parquet t')]);
    const tree = resolvePlanTree(rawNode('Sort', [rawNode('Exchange', [join])]), new Map(), new Map(), undefined);
    expect(tree.children[0].rowWidth).toBeUndefined();
  });
});

describe('resolvePlanTree: exchange input columns', () => {
  const exchange = (planId) => rawNode('Exchange', [rawNode('SortMergeJoin', [rawNode('Scan parquet t')])], {
    detail: `Exchange hashpartitioning(k#1, 200), ENSURE_REQUIREMENTS, [plan_id=${planId}]`,
  });

  it('gives the write half of an exchange the column count its plan_id has in the plan description', () => {
    const root = rawNode('Union', [exchange(53), exchange(61), rawNode('Exchange', [rawNode('Scan parquet u')])]);
    const tree = resolvePlanTree(root, new Map(), new Map(), undefined, undefined, undefined, new Map([[53, 3], [61, 128]]));

    const writes = tree.children.map((read) => read.children[0]);
    expect(writes.map((write) => write.inputColumns)).toEqual([3, 128, undefined]);
    expect(tree.children.every((read) => read.inputColumns === undefined)).toBe(true);
    expect(tree.children[0].rowWidth).toEqual({ columns: 3 });
  });
});
