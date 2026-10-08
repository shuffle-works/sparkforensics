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

describe('stageIdentityWith whole-tree fallback', () => {
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
