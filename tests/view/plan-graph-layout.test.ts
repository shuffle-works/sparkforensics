import { describe, it, expect } from 'vitest';
import { layoutWithDagre, computeGroupBounds, computeGroupBoundsWithFallback, NODE_WIDTH, NODE_HEIGHT } from '../../src/view/plan-graph/dagre-layout';
import type { PlanGraphEdge, PlanGraphNodeData } from '@sparkforensics/core/types.ts';

function graphNode(id: string, overrides: Partial<PlanGraphNodeData> = {}): PlanGraphNodeData {
  return {
    id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '',
    segmentIndex: 0, splitRole: null, durationShare: null, ...overrides,
  };
}

describe('layoutWithDagre', () => {
  it('assigns every node a numeric position', () => {
    const nodes = [graphNode('a'), graphNode('b')];
    const edges: PlanGraphEdge[] = [{ id: 'a->b', source: 'a', target: 'b' }];

    const laidOut = layoutWithDagre(nodes, edges);

    expect(laidOut).toHaveLength(2);
    for (const n of laidOut) {
      expect(typeof n.position.x).toBe('number');
      expect(typeof n.position.y).toBe('number');
    }
  });

  it('places an edge\'s target (child/producer, e.g. a Scan) left of its source (parent/consumer, e.g. a Join)', () => {
    // Matches plan-graph-model.js's `source: parentId, target: id`, the
    // target is the plan-tree child, computed before its parent consumes it.
    const nodes = [graphNode('join'), graphNode('scan')];
    const edges: PlanGraphEdge[] = [{ id: 'join->scan', source: 'join', target: 'scan' }];

    const laidOut = layoutWithDagre(nodes, edges);
    const join = laidOut.find((n) => n.id === 'join')!;
    const scan = laidOut.find((n) => n.id === 'scan')!;

    expect(join.position.x).not.toBe(scan.position.x);
    expect(scan.position.x).toBeLessThan(join.position.x);
  });

  it('preserves every field from the input node alongside the new position', () => {
    const nodes = [graphNode('a', { label: 'Scan parquet', category: 'scan' })];
    const laidOut = layoutWithDagre(nodes, []);

    expect(laidOut[0]).toMatchObject({ id: 'a', label: 'Scan parquet', category: 'scan' });
  });

  it('groups nodes into a compound cluster when groupOf is provided', () => {
    const nodes = [graphNode('a', { segmentIndex: 0 }), graphNode('b', { segmentIndex: 1 })];
    const edges: PlanGraphEdge[] = [];

    const laidOut = layoutWithDagre(nodes, edges, { groupOf: (n) => `segment-${n.segmentIndex}` });

    expect(laidOut.find((n) => n.id === 'a')!.position).toBeTruthy();
    expect(laidOut.find((n) => n.id === 'b')!.position).toBeTruthy();
  });
});

describe('computeGroupBounds', () => {
  it('bounds a group to the union of its members\' rectangles, padded', () => {
    const laidOut = [
      graphNode('a', { segmentIndex: 0 }),
      graphNode('b', { segmentIndex: 0 }),
      graphNode('c', { segmentIndex: 1 }),
    ].map((n, i) => ({ ...n, position: { x: i * 300, y: 0 } }));
    const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;

    const groups = computeGroupBounds(laidOut, groupOf);

    expect(groups).toHaveLength(2);
    const seg0 = groups.find((g) => g.id === 'segment-0')!;
    // Spans both a (x=0) and b (x=300), so its width covers both plus padding.
    expect(seg0.width).toBeGreaterThan(300);
    expect(seg0.position.x).toBeLessThan(0);
  });

  it('excludes nodes for which groupOf returns null', () => {
    const laidOut = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const groups = computeGroupBounds(laidOut, () => null);
    expect(groups).toHaveLength(0);
  });

  it('accepts wider paddingX/paddingY/headerHeight so an outer group strictly contains an inner one over the same nodes', () => {
    const laidOut = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const groupOf = () => 'g';

    const inner = computeGroupBounds(laidOut, groupOf)[0];
    const outer = computeGroupBounds(laidOut, groupOf, { paddingX: 40, paddingY: 40, headerHeight: 32 })[0];

    expect(outer.position.x).toBeLessThan(inner.position.x);
    expect(outer.position.y).toBeLessThan(inner.position.y);
    expect(outer.position.x + outer.width).toBeGreaterThan(inner.position.x + inner.width);
    expect(outer.position.y + outer.height).toBeGreaterThan(inner.position.y + inner.height);
  });

  it('applies paddingX and paddingY independently (asymmetric margins)', () => {
    const laidOut = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const groupOf = () => 'g';

    const group = computeGroupBounds(laidOut, groupOf, { paddingX: 10, paddingY: 50, headerHeight: 0 })[0];

    expect(group.width).toBe(NODE_WIDTH + 20);
    expect(group.height).toBe(NODE_HEIGHT + 100);
  });
});

describe('computeGroupBoundsWithFallback', () => {
  const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;

  it('bounds a group from the first candidate layout that has a member for it', () => {
    const primary = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const fallback = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 900, y: 900 } }));

    const groups = computeGroupBoundsWithFallback(groupOf, [primary, fallback]);

    expect(groups).toHaveLength(1);
    expect(groups[0].position.x).toBeLessThan(500);
  });

  it('falls back to a later candidate layout for a group missing from every earlier one', () => {
    const primary = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const fallback = [
      graphNode('a', { segmentIndex: 0 }),
      graphNode('b', { segmentIndex: 1 }),
    ].map((n, i) => ({ ...n, position: { x: i * 300, y: 0 } }));

    const groups = computeGroupBoundsWithFallback(groupOf, [primary, fallback]);

    expect(groups.map((g) => g.id).sort()).toEqual(['segment-0', 'segment-1']);
    // segment-0 still came from the primary candidate, not the fallback.
    expect(groups.find((g) => g.id === 'segment-0')!.position.x).toBeLessThan(200);
    // segment-1 only exists in the fallback candidate.
    expect(groups.find((g) => g.id === 'segment-1')!.position.x).toBeGreaterThan(200);
  });

  it('never returns the same group id twice even when multiple candidates cover it', () => {
    const primary = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 0, y: 0 } }));
    const fallback = [graphNode('a', { segmentIndex: 0 })].map((n) => ({ ...n, position: { x: 500, y: 500 } }));

    const groups = computeGroupBoundsWithFallback(groupOf, [primary, fallback]);

    expect(groups).toHaveLength(1);
  });

  it('returns nothing for a group absent from every candidate', () => {
    const primary: ReturnType<typeof layoutWithDagre> = [];

    const groups = computeGroupBoundsWithFallback(groupOf, [primary]);

    expect(groups).toHaveLength(0);
  });
});
