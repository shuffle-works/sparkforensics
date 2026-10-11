import { describe, it, expect } from 'vitest';
import { planNodesOfStage } from '../src/stage-plan-nodes.js';
import { stageIdentityWith } from '../src/stage-identity.js';

const node = (name, detail, stageIds, children = []) => ({ name, detail, metrics: [], children, stageIds });

function snapshotWith(planTree) {
  return { sql: new Map([[1, { id: 1, description: 'q', planTree }]]) };
}

describe('planNodesOfStage', () => {
  const leafA = node('Scan a', 'a', [1, 1]);
  const leafB = node('Scan b', 'b', [2]);
  const root = node('Root', 'r', [1, 2], [leafA, leafB]);
  const { sql } = snapshotWith(root);

  it('returns the stage nodes in preorder, once each even when a stage id repeats', () => {
    expect(planNodesOfStage({ id: 1, sqlExecutionId: 1 }, sql)).toEqual([root, leafA]);
    expect(planNodesOfStage({ id: 2, sqlExecutionId: 1 }, sql)).toEqual([root, leafB]);
  });

  it('returns an empty list for an unattributed stage or a stage without an execution', () => {
    expect(planNodesOfStage({ id: 9, sqlExecutionId: 1 }, sql)).toEqual([]);
    expect(planNodesOfStage({ id: 1, sqlExecutionId: null }, sql)).toEqual([]);
  });

  it('hands out a copy, so a caller cannot change what the next caller sees', () => {
    planNodesOfStage({ id: 1, sqlExecutionId: 1 }, sql).length = 0;
    expect(planNodesOfStage({ id: 1, sqlExecutionId: 1 }, sql)).toHaveLength(2);
  });
});

describe('the plan walks are memoized per resolved tree', () => {
  it('walks a tree for its stage nodes once, whichever stage asks', () => {
    let reads = 0;
    const counted = (name, stageIds, children = []) => {
      const n = { name, detail: name, metrics: [], children };
      Object.defineProperty(n, 'stageIds', { get() { reads++; return stageIds; } });
      return n;
    };
    const root = counted('Root', [1, 2], [counted('A', [1]), counted('B', [2])]);
    const { sql } = snapshotWith(root);
    expect(planNodesOfStage({ id: 1, sqlExecutionId: 1 }, sql)).toHaveLength(2);
    expect(reads).toBe(3);
    expect(planNodesOfStage({ id: 2, sqlExecutionId: 1 }, sql)).toHaveLength(2);
    expect(planNodesOfStage({ id: 1, sqlExecutionId: 1 }, sql)).toHaveLength(2);
    expect(reads).toBe(3);
  });
});

describe('stageIdentityWith whole-tree fallback', () => {
  const countedNormalizer = () => {
    const normalize = (d) => { normalize.calls++; return d; };
    normalize.calls = 0;
    return normalize;
  };

  it('digests a tree once per normalizer, shared by every stage that falls back to it', () => {
    const snapshot = snapshotWith(node('Root', 'x 123', [], [node('Leaf', 'y 456', [])]));
    const normalize = countedNormalizer();
    const a = stageIdentityWith({ id: 7, name: 'Stage 7', sqlExecutionId: 1 }, snapshot, normalize);
    expect(normalize.calls).toBe(2);
    stageIdentityWith({ id: 7, name: 'Stage 7', sqlExecutionId: 1 }, snapshot, normalize);
    const b = stageIdentityWith({ id: 8, name: 'Stage 8', sqlExecutionId: 1 }, snapshot, normalize);
    expect(normalize.calls).toBe(2);
    expect(a.split('§')[1]).toBe(b.split('§')[1]);
  });

  it('recomputes for a normalizer the per-tree cache dropped, and only that one', () => {
    const snapshot = snapshotWith(node('Root', 'x', [], [node('Leaf', 'y', [])]));
    const stage = { id: 7, name: 'Stage 7', sqlExecutionId: 1 };
    const normalizers = Array.from({ length: 5 }, countedNormalizer);
    for (const n of normalizers) stageIdentityWith(stage, snapshot, n);
    // The cache keeps 4: the first normalizer was dropped by the fifth, the rest are still held.
    stageIdentityWith(stage, snapshot, normalizers[4]);
    stageIdentityWith(stage, snapshot, normalizers[1]);
    expect(normalizers.map((n) => n.calls)).toEqual([2, 2, 2, 2, 2]);
    stageIdentityWith(stage, snapshot, normalizers[0]);
    expect(normalizers[0].calls).toBe(4);
  });


  const snapshot = snapshotWith(node('Root', 'x 123', [], [node('Leaf', 'y 456', [])]));
  const stage = { id: 7, name: 'Stage 7', sqlExecutionId: 1 };

  it('gives the same identity on repeated calls and differs by normalizer', () => {
    const lower = (d) => d.toLowerCase();
    const upper = (d) => d.toUpperCase();
    const first = stageIdentityWith(stage, snapshot, lower);
    expect(stageIdentityWith(stage, snapshot, lower)).toBe(first);
    expect(stageIdentityWith(stage, snapshot, upper)).not.toBe(first);
  });

  it('stays correct across more normalizers than the per-tree cache keeps', () => {
    const normalizers = Array.from({ length: 10 }, (_, i) => (d) => `${i}:${d}`);
    const expected = normalizers.map((n) => stageIdentityWith(stage, snapshot, n));
    expect(new Set(expected).size).toBe(10);
    normalizers.forEach((n, i) => expect(stageIdentityWith(stage, snapshot, n)).toBe(expected[i]));
  });
});
