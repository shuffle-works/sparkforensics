import { describe, it, expect, beforeEach, vi } from 'vitest';
import dagre from '@dagrejs/dagre';
import { layoutWithDagre, clearLayoutCache, computeGroupBounds, computeGroupBoundsWithFallback, NODE_WIDTH, NODE_HEIGHT } from '../../src/view/plan-graph/dagre-layout';
import type { PlanGraphEdge, PlanGraphNodeData } from '@sparkforensics/core/types.ts';

function graphNode(id: string, overrides: Partial<PlanGraphNodeData> = {}): PlanGraphNodeData {
  return {
    id, sourceNodeId: id, label: id, category: 'transform', operatorDetail: '', primaryMetric: '',
    segmentIndex: 0, splitRole: null, durationShare: null, ...overrides,
  };
}

describe('layoutWithDagre direction', () => {
  const chain = ['a', 'b', 'c', 'd'].map((id) => graphNode(id));
  const edges: PlanGraphEdge[] = [
    { id: 'a->b', source: 'a', target: 'b' },
    { id: 'b->c', source: 'b', target: 'c' },
    { id: 'c->d', source: 'c', target: 'd' },
  ];
  const extent = (nodes: { position: { x: number; y: number } }[], axis: 'x' | 'y') => {
    const values = nodes.map((n) => n.position[axis]);
    return Math.max(...values) - Math.min(...values);
  };

  it('lays a chain out as a wide band right-to-left by default', () => {
    const laidOut = layoutWithDagre(chain, edges);
    expect(extent(laidOut, 'x')).toBeGreaterThan(extent(laidOut, 'y'));
  });

  it('stacks the same chain vertically when asked for bottom-to-top, consumer below its producer', () => {
    const laidOut = layoutWithDagre(chain, edges, { direction: 'BT' });
    expect(extent(laidOut, 'y')).toBeGreaterThan(extent(laidOut, 'x'));
    const y = (id: string) => laidOut.find((n) => n.id === id)!.position.y;
    // edge source = consumer (parent), target = producer (child): producer on top.
    expect(y('d')).toBeLessThan(y('a'));
  });
});

describe('desktop layout never wraps', () => {
  // The default (right-to-left) layout keeps the plan's tree flow at every size:
  // an ancestor (an edge's source) always sits to the right of its descendant.
  const sourcesRightOfTargets = (nodes: { id: string; position: { x: number } }[], edges: PlanGraphEdge[]) => {
    const x = (id: string) => nodes.find((n) => n.id === id)!.position.x;
    return edges.every((e) => x(e.source) >= x(e.target) + NODE_WIDTH);
  };
  const chainOf = (length: number) => {
    const ids = Array.from({ length }, (_, i) => `s${i}`);
    return {
      nodes: ids.map((id, i) => graphNode(id, { segmentIndex: i })),
      edges: ids.slice(0, -1).map((id, i): PlanGraphEdge => ({ id: `${id}->${ids[i + 1]}`, source: id, target: ids[i + 1] })),
    };
  };
  const segmentOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;

  it.each([3, 8, 40])('lays a %i-stage chain out on one row, every ancestor right of its descendant', (length) => {
    const { nodes, edges } = chainOf(length);
    const laidOut = layoutWithDagre(nodes, edges, { groupOf: segmentOf });
    expect(new Set(laidOut.map((n) => n.position.y)).size).toBe(1);
    expect(sourcesRightOfTargets(laidOut, edges)).toBe(true);
  });

  it('keeps a join of two long branches flowing right-to-left across the full plan width', () => {
    const left = chainOf(10).nodes.map((n) => ({ ...n, id: `l${n.id}`, segmentIndex: n.segmentIndex }));
    const right = chainOf(10).nodes.map((n) => ({ ...n, id: `r${n.id}`, segmentIndex: 100 + n.segmentIndex }));
    const join = graphNode('join', { segmentIndex: 999 });
    const edges: PlanGraphEdge[] = [
      ...left.slice(0, -1).map((n, i): PlanGraphEdge => ({ id: `${n.id}->${left[i + 1].id}`, source: n.id, target: left[i + 1].id })),
      ...right.slice(0, -1).map((n, i): PlanGraphEdge => ({ id: `${n.id}->${right[i + 1].id}`, source: n.id, target: right[i + 1].id })),
      { id: 'join->l', source: 'join', target: left[0].id },
      { id: 'join->r', source: 'join', target: right[0].id },
    ];
    const laidOut = layoutWithDagre([join, ...left, ...right], edges, { groupOf: segmentOf });
    expect(sourcesRightOfTargets(laidOut, edges)).toBe(true);
    // The branches may stack in y, but the plan is never cut into rows: it spans the whole chain length.
    const xs = laidOut.map((n) => n.position.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThanOrEqual(10 * NODE_WIDTH);
  });
});

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

describe('layout cache', () => {
  const edges: PlanGraphEdge[] = [
    { id: 'a->b', source: 'a', target: 'b' },
    { id: 'a->c', source: 'a', target: 'c' },
  ];
  const nodes = (overrides: Partial<PlanGraphNodeData> = {}) =>
    ['a', 'b', 'c'].map((id, i) => graphNode(id, { segmentIndex: i % 2, ...overrides }));
  const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;

  beforeEach(() => clearLayoutCache());

  it('reuses positions when only node data changes, and carries the new data through', () => {
    const spy = vi.spyOn(dagre, 'layout');
    const first = layoutWithDagre(nodes({ durationShare: 0.2 }), edges, { groupOf });
    const second = layoutWithDagre(nodes({ durationShare: 0.9 }), edges, { groupOf });
    expect(spy).toHaveBeenCalledTimes(1);
    expect(second.map((n) => n.position)).toEqual(first.map((n) => n.position));
    expect(second.every((n) => n.durationShare === 0.9)).toBe(true);
    spy.mockRestore();
  });

  it('hands out independent position objects on a cache hit', () => {
    const first = layoutWithDagre(nodes(), edges, { groupOf });
    first[0].position.x = 12345;
    const second = layoutWithDagre(nodes(), edges, { groupOf });
    expect(second[0].position.x).not.toBe(12345);
  });

  it('lays out again when the topology, grouping or direction changes', () => {
    const spy = vi.spyOn(dagre, 'layout');
    layoutWithDagre(nodes(), edges, { groupOf });
    layoutWithDagre(nodes(), edges.slice(0, 1), { groupOf });
    layoutWithDagre(nodes(), edges, { groupOf: () => 'segment-0' });
    layoutWithDagre(nodes(), edges, { groupOf, direction: 'BT' });
    layoutWithDagre(nodes(), edges);
    expect(spy).toHaveBeenCalledTimes(5);
    spy.mockRestore();
  });
});
