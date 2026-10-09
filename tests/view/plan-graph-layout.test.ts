import { describe, it, expect } from 'vitest';
import { layoutWithDagre, wrapIntoRows, computeGroupBounds, computeGroupBoundsWithFallback, NODE_WIDTH, NODE_HEIGHT, STAGE_GROUP_PADDING_X, STAGE_GROUP_PADDING_Y, STAGE_GROUP_HEADER_HEIGHT } from '../../src/view/plan-graph/dagre-layout';
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

describe('wrapIntoRows', () => {
  // A chain of 8 single-node stages, two segments per stage: s0 (the root,
  // consumes s1) ... s7 (the scan). Laid out right-to-left it is one wide band.
  const ids = ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7'];
  const chain = ids.map((id, i) => graphNode(id, { segmentIndex: i }));
  const edges: PlanGraphEdge[] = ids.slice(0, -1).map((id, i) => ({ id: `${id}->${ids[i + 1]}`, source: id, target: ids[i + 1] }));
  const segmentOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;
  const stageOf = (n: PlanGraphNodeData) => `stage-${Math.floor(n.segmentIndex / 2)}`;
  const rowWidth = 1100;
  const laidOut = () => layoutWithDagre(chain, edges, { groupOf: segmentOf });
  const at = (nodes: { id: string; position: { x: number; y: number } }[], id: string) => nodes.find((n) => n.id === id)!.position;

  it('leaves a layout that already fits one row untouched', () => {
    const band = laidOut();
    expect(wrapIntoRows(band, [segmentOf, stageOf], 100_000)).toBe(band);
  });

  it('wraps a long chain into rows no wider than the limit, starting with the scans on the top-left', () => {
    const wrapped = wrapIntoRows(laidOut(), [segmentOf, stageOf], rowWidth);
    const rows = [...new Set(wrapped.map((n) => n.position.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThan(1);
    for (const y of rows) {
      const xs = wrapped.filter((n) => n.position.y === y).map((n) => n.position.x);
      expect(Math.max(...xs) + NODE_WIDTH - Math.min(...xs)).toBeLessThanOrEqual(rowWidth);
    }
    expect(at(wrapped, 's7').y).toBe(rows[0]);
    expect(at(wrapped, 's0').y).toBe(rows[rows.length - 1]);
    const firstRowXs = wrapped.filter((n) => n.position.y === rows[0]).map((n) => n.position.x);
    expect(at(wrapped, 's7').x).toBe(Math.min(...firstRowXs));
  });

  it('never splits a stage across rows, and keeps stacked stage boxes from overlapping', () => {
    const wrapped = wrapIntoRows(laidOut(), [segmentOf, stageOf], rowWidth);
    for (let stage = 0; stage < 4; stage++) {
      expect(at(wrapped, ids[stage * 2]).y).toBe(at(wrapped, ids[stage * 2 + 1]).y);
    }
    const boxes = computeGroupBounds(wrapped, stageOf, {
      paddingX: STAGE_GROUP_PADDING_X, paddingY: STAGE_GROUP_PADDING_Y, headerHeight: STAGE_GROUP_HEADER_HEIGHT,
    });
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const overlapX = a.position.x < b.position.x + b.width && b.position.x < a.position.x + a.width;
        const overlapY = a.position.y < b.position.y + b.height && b.position.y < a.position.y + a.height;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('cuts a single group wider than the limit between its columns, its box containing every row', () => {
    const oneSegment = () => 'segment-0';
    const wrapped = wrapIntoRows(layoutWithDagre(chain, edges, { groupOf: oneSegment }), [oneSegment], rowWidth);
    const rows = [...new Set(wrapped.map((n) => n.position.y))].sort((a, b) => a - b);
    expect(rows.length).toBeGreaterThan(1);
    for (const y of rows) {
      const xs = wrapped.filter((n) => n.position.y === y).map((n) => n.position.x);
      expect(Math.max(...xs) + NODE_WIDTH - Math.min(...xs)).toBeLessThanOrEqual(rowWidth);
    }
    const [box] = computeGroupBounds(wrapped, oneSegment);
    for (const n of wrapped) {
      expect(n.position.x).toBeGreaterThanOrEqual(box.position.x);
      expect(n.position.y).toBeGreaterThanOrEqual(box.position.y);
      expect(n.position.x + NODE_WIDTH).toBeLessThanOrEqual(box.position.x + box.width);
      expect(n.position.y + NODE_HEIGHT).toBeLessThanOrEqual(box.position.y + box.height);
    }
  });

  it('records each row and the gap below it, between that row and the next', () => {
    const oneSegment = () => 'segment-0';
    const wrapped = wrapIntoRows(layoutWithDagre(chain, edges, { groupOf: oneSegment }), [oneSegment], rowWidth);
    const first = wrapped.filter((n) => n.row!.index === 0);
    const second = wrapped.filter((n) => n.row!.index === 1);
    const gapY = first[0].row!.gapBelowY;
    expect(Math.max(...first.map((n) => n.position.y + NODE_HEIGHT))).toBeLessThan(gapY);
    expect(Math.min(...second.map((n) => n.position.y))).toBeGreaterThan(gapY);
  });

  it('gives a stage cut across rows rows of its own, so its box covers no other stage', () => {
    // Stage 0 holds s0..s5 (wider than a row); stage 1 holds s6 and s7.
    const bigStageOf = (n: PlanGraphNodeData) => `stage-${n.segmentIndex < 6 ? 0 : 1}`;
    const wrapped = wrapIntoRows(laidOut(), [segmentOf, bigStageOf], rowWidth);
    const rowsOfStage = (stage: string) => new Set(wrapped.filter((n) => bigStageOf(n) === stage).map((n) => n.row!.index));
    const big = rowsOfStage('stage-0');
    expect(big.size).toBeGreaterThan(1);
    for (const r of rowsOfStage('stage-1')) expect(big.has(r)).toBe(false);
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
