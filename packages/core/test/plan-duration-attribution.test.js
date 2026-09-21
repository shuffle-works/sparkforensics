import { describe, it, expect } from 'vitest';
import {
  attributeStageDurationToPlan,
  attributeStageDurationToPlanInclusive,
  computeSegments,
  zipSegmentsToStages,
  mapSegmentsToStagesForDisplay,
} from '../src/plan-duration-attribution.js';

// Mirrors resolvePlanTree's real split shape (see event-handlers.ts): the
// write half keeps children/metrics, detail=''; the read half wraps write,
// keeps the original name/detail, metrics=[]. computeSegments cuts on
// exchangeRole now, not a name regex, so every fixture below that needs to
// exercise an Exchange boundary builds one of these instead of a bare
// { name: 'Exchange...' } node (which never cuts: it carries no exchangeRole).
function splitExchange(name, children, detail = name) {
  const write = { name, detail: '', metrics: [], children, exchangeRole: 'write' };
  const read = { name, detail, metrics: [], children: [write], exchangeRole: 'read' };
  return [read, write];
}

// tree: root → exchange1 → mid → exchange2 → leaf  (2 exchanges = 3 segments)
function node(name, children = [], metrics = []) { return { name, detail: '', metrics, children }; }
function buildTree() {
  const leaf = node('LeafScan');
  const [exchange2, write2] = splitExchange('Exchange', [leaf]);
  const mid = node('HashAggregate', [exchange2]);
  const [exchange1, write1] = splitExchange('Exchange', [mid]);
  const root = node('Project', [exchange1]);
  return { root, leaf, exchange2, write2, mid, exchange1, write1 };
}

// Uneven component topology (component ids are allocated in pre-order):
//
//   component 0: Join + both outer Exchanges
//   component 1: left + deep Exchange       (depth 1)
//   component 2: deep                       (depth 2)
//   component 3: right                      (depth 1)
//
// Sorting numeric ids descending incorrectly puts the shallow right branch
// before the deepest component. The topology, not the identity, determines
// execution order and structural distance.
function buildUnevenTree() {
  const deep = node('Scan deep');
  const [deepExchange, deepWrite] = splitExchange('Exchange deep', [deep]);
  const left = node('Project left', [deepExchange]);
  const [leftExchange, leftWrite] = splitExchange('Exchange left', [left]);
  const right = node('Scan right');
  const [rightExchange, rightWrite] = splitExchange('Exchange right', [right]);
  const root = node('Join', [leftExchange, rightExchange]);
  return { root, deep, deepWrite, left, leftWrite, right, rightWrite };
}

describe('attributeStageDurationToPlan', () => {
  it('attributes each stage wall-time to its segment, equal-split fallback', () => {
    const { root, leaf, write2, mid, exchange1, write1 } = buildTree();
    // segments: seg0={root,exchange1}, segA={write1,mid,exchange2}, segB={write2,leaf}
    // (the write half of each split Exchange joins whichever segment follows
    // it, per computeSegments' exchangeRole==='read' cut rule)
    // deepest-first zip with submission-ordered stages:
    //   segB(write2,leaf) ← stage 10 (earliest, wall 200) → 100 each
    //   segA(write1,mid,exchange2) ← stage 11 (wall 300) → 100 each
    //   seg0(root,exchange1) ← stage 12 (wall 600) → 300 each
    const stagesById = new Map([
      [10, { submittedAt: 0,    completedAt: 200 }],
      [11, { submittedAt: 1000, completedAt: 1300 }],
      [12, { submittedAt: 2000, completedAt: 2600 }],
    ]);
    const map = attributeStageDurationToPlan(root, stagesById, { stageIds: [10, 11, 12] });
    expect(map.get(leaf)).toBe(100);
    expect(map.get(write2)).toBe(100);
    expect(map.get(mid)).toBe(100);
    expect(map.get(write1)).toBe(100);
    expect(map.get(root)).toBe(300);
    expect(map.get(exchange1)).toBe(300);
  });

  it('weights by per-node timing metric when present', () => {
    const { root, mid, write1 } = buildTree();
    // put a timing metric on mid (900) and on write1 (100) → 9:1 split of
    // that segment's stage wall time. Real per-node Exchange metrics live on
    // the write half, per the Exchange split's partitioning rule; the
    // segment's third member (the inner exchange's read half) carries none.
    mid.metrics = [{ name: 'aggregate time', value: 900, metricType: 'timing' }];
    write1.metrics = [{ name: 'shuffle write time', value: 100, metricType: 'timing' }];
    const stagesById = new Map([
      [10, { submittedAt: 0,    completedAt: 200 }],
      [11, { submittedAt: 1000, completedAt: 2000 }],
      [12, { submittedAt: 2000, completedAt: 2600 }],
    ]);
    const map = attributeStageDurationToPlan(root, stagesById, { stageIds: [10, 11, 12] });
    expect(map.get(mid)).toBe(900);       // 1000 * 900/1000
    expect(map.get(write1)).toBe(100);    // 1000 * 100/1000
  });

  it('returns an empty map when sqlExec has no stageIds', () => {
    const { root } = buildTree();
    expect(attributeStageDurationToPlan(root, new Map(), { stageIds: [] }).size).toBe(0);
  });
});

describe('computeSegments / zipSegmentsToStages', () => {
  function node(name, children = [], metrics = []) { return { name, detail: '', metrics, children }; }

  it('assigns segment 0 to the root and increments only past an Exchange parent', () => {
    const leaf = node('Scan parquet');
    const [exchange, write] = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);

    const { segments, segOf } = computeSegments(root);

    expect(segOf.get(root)).toBe(0);
    expect(segOf.get(exchange)).toBe(0);
    expect(segOf.get(write)).toBe(1);
    expect(segOf.get(leaf)).toBe(1);
    expect(segments[0]).toEqual([root, exchange]);
    expect(segments[1]).toEqual([write, leaf]);
  });

  it('cuts a new segment at the write half, keeping the read half in the parent segment', () => {
    const write = { name: 'Exchange', detail: '', metrics: [], children: [node('Scan parquet')], exchangeRole: 'write' };
    const read = { name: 'Exchange', detail: 'Exchange hashpartitioning', metrics: [], children: [write], exchangeRole: 'read' };
    const root = node('SortMergeJoin', [read]);

    const { segOf } = computeSegments(root);
    expect(segOf.get(root)).toBe(segOf.get(read));
    expect(segOf.get(write)).not.toBe(segOf.get(read));
    expect(segOf.get(write)).toBe(segOf.get(write.children[0]));
  });

  it('does not cut a segment at a ReusedExchange parent (never split, carries no exchangeRole)', () => {
    const leaf = node('Scan parquet');
    const reused = node('ReusedExchange', [leaf]);
    const root = node('SortMergeJoin', [reused]);

    const { segOf } = computeSegments(root);
    expect(segOf.get(root)).toBe(segOf.get(reused));
    expect(segOf.get(leaf)).toBe(segOf.get(reused));
  });

  it('assigns a distinct segment to each producer component below sibling Exchanges', () => {
    const left = node('Scan left');
    const right = node('Scan right');
    const [leftExchange, leftWrite] = splitExchange('Exchange left', [left]);
    const [rightExchange, rightWrite] = splitExchange('Exchange right', [right]);
    const root = node('Join', [leftExchange, rightExchange]);

    const { segments, segOf } = computeSegments(root);

    expect(segments.filter(Boolean)).toHaveLength(3);
    expect(segOf.get(root)).toBe(segOf.get(leftExchange));
    expect(segOf.get(root)).toBe(segOf.get(rightExchange));
    expect(segOf.get(leftWrite)).not.toBe(segOf.get(root));
    expect(segOf.get(rightWrite)).not.toBe(segOf.get(root));
    expect(segOf.get(leftWrite)).not.toBe(segOf.get(rightWrite));
    expect(segOf.get(left)).toBe(segOf.get(leftWrite));
    expect(segOf.get(right)).toBe(segOf.get(rightWrite));
  });

  it('zips deepest segment to earliest-submitted stage', () => {
    const leaf = node('Scan parquet');
    const [exchange, write] = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const { segments, segmentTopology } = computeSegments(root);
    const stagesById = new Map([
      [10, { submittedAt: 100, completedAt: 400 }],
      [20, { submittedAt: 500, completedAt: 900 }],
    ]);

    const { pairs } = zipSegmentsToStages(segments, stagesById, [20, 10], segmentTopology);

    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toMatchObject({ segmentIndex: 1, stageId: 10, nodes: [write, leaf] });
    expect(pairs[1]).toMatchObject({ segmentIndex: 0, stageId: 20, nodes: [root, exchange] });
  });

  it('pairs an uneven plan by explicit component depth so its deepest branch receives the earliest stage duration', () => {
    const { root, deep, deepWrite, left, right } = buildUnevenTree();
    const { segments, segOf, segmentTopology } = computeSegments(root);
    const stagesById = new Map([
      [10, { submittedAt: 0,    completedAt: 200 }],
      [20, { submittedAt: 200,  completedAt: 500 }],
      [30, { submittedAt: 500,  completedAt: 1100 }],
      [40, { submittedAt: 1100, completedAt: 1500 }],
    ]);

    const { pairs } = zipSegmentsToStages(segments, stagesById, [40, 30, 20, 10], segmentTopology);
    const durations = attributeStageDurationToPlan(root, stagesById, { stageIds: [40, 30, 20, 10] });

    expect(pairs[0]).toMatchObject({ segmentIndex: segOf.get(deep), stageId: 10, nodes: [deepWrite, deep] });
    expect(durations.get(deep)).toBe(100);
    expect(durations.get(left)).toBe(100);
    expect(durations.get(right)).toBe(300);
  });
});

describe('mapSegmentsToStagesForDisplay', () => {
  function node(name, children = []) { return { name, detail: '', metrics: [], children }; }

  it('matches zipSegmentsToStages exactly when segment and stage counts are equal', () => {
    const leaf = node('Scan parquet');
    const [exchange] = splitExchange('Exchange hashpartitioning', [leaf]);
    const root = node('SortMergeJoin', [exchange]);
    const { segments, segmentTopology } = computeSegments(root);
    const stagesById = new Map([
      [10, { submittedAt: 100, completedAt: 400 }],
      [20, { submittedAt: 500, completedAt: 900 }],
    ]);

    const map = mapSegmentsToStagesForDisplay(segments, stagesById, [20, 10], segmentTopology);

    expect(map).toEqual(new Map([[1, 10], [0, 20]]));
  });

  it("fills a segment past the Math.min(segments, stages) cutoff with its nearest strictly-paired neighbor's stage, instead of leaving it unmapped", () => {
    // 3 segments (2 Exchanges), only 1 real stage: the strict zip pairs the
    // deepest segment (2, the leaf's) to the one stage, leaving segments 1 and
    // 0 (shallower, closer to the root) with no timing data of their own.
    const leaf = node('Scan parquet');
    const [exchange2] = splitExchange('Exchange hashpartitioning', [leaf]);
    const mid = node('HashAggregate', [exchange2]);
    const [exchange1] = splitExchange('Exchange hashpartitioning', [mid]);
    const root = node('Project', [exchange1]);
    const { segments, segmentTopology } = computeSegments(root);
    const stagesById = new Map([[10, { submittedAt: 0, completedAt: 500 }]]);

    const strict = zipSegmentsToStages(segments, stagesById, [10], segmentTopology);
    expect(strict.pairs).toHaveLength(1); // sanity: confirms the gap this test fills

    const map = mapSegmentsToStagesForDisplay(segments, stagesById, [10], segmentTopology);

    expect(map).toEqual(new Map([[2, 10], [1, 10], [0, 10]]));
  });

  it('fills each unmapped segment from whichever strictly-paired segment is structurally closest, without chaining through another filled segment', () => {
    // 4 segments, 2 stages: segments 3 and 2 win the strict zip. Segments 1
    // and 0 are each nearer to segment 2 than to segment 3, so both should
    // inherit segment 2's stage, never chain off segment 1 once it's filled.
    const a = node('Scan parquet');
    const [exB] = splitExchange('Exchange hashpartitioning', [a]);
    const b = node('HashAggregate', [exB]);
    const [exC] = splitExchange('Exchange hashpartitioning', [b]);
    const c = node('HashAggregate', [exC]);
    const [exD] = splitExchange('Exchange hashpartitioning', [c]);
    const root = node('Project', [exD]);
    const { segments, segmentTopology } = computeSegments(root);
    const stagesById = new Map([
      [10, { submittedAt: 0, completedAt: 100 }],
      [20, { submittedAt: 100, completedAt: 200 }],
    ]);

    const map = mapSegmentsToStagesForDisplay(segments, stagesById, [20, 10], segmentTopology);

    expect(map).toEqual(new Map([[3, 10], [2, 20], [1, 20], [0, 20]]));
  });

  it('uses component-tree distance for an uneven branch instead of numeric id distance', () => {
    const { root, deep, left, right } = buildUnevenTree();
    const { segments, segOf, segmentTopology } = computeSegments(root);
    const stagesById = new Map([
      [10, { submittedAt: 0, completedAt: 100 }],
      [20, { submittedAt: 100, completedAt: 300 }],
    ]);

    const map = mapSegmentsToStagesForDisplay(segments, stagesById, [20, 10], segmentTopology);

    expect(map.get(segOf.get(deep))).toBe(10);
    expect(map.get(segOf.get(left))).toBe(20);
    // right's numeric id is closest to deep's, but in the component tree it
    // is one edge closer to left's component via their shared root.
    expect(map.get(segOf.get(right))).toBe(20);
  });

  it('returns an empty map when there are no stages to pair against', () => {
    const leaf = node('Scan parquet');
    const { segments, segmentTopology } = computeSegments(leaf);
    expect(mapSegmentsToStagesForDisplay(segments, new Map(), [], segmentTopology)).toEqual(new Map());
  });

  it("never changes attributeStageDurationToPlan's own output for the same mismatched counts", () => {
    // Display-only inheritance must never leak into duration attribution:
    // only the strictly-paired segment's nodes get a real share.
    const leaf = node('Scan parquet');
    const [exchange2] = splitExchange('Exchange hashpartitioning', [leaf]);
    const mid = node('HashAggregate', [exchange2]);
    const [exchange1] = splitExchange('Exchange hashpartitioning', [mid]);
    const root = node('Project', [exchange1]);
    const stagesById = new Map([[10, { submittedAt: 0, completedAt: 500 }]]);

    const durationMap = attributeStageDurationToPlan(root, stagesById, { stageIds: [10] });

    expect(durationMap.has(leaf)).toBe(true);
    expect(durationMap.has(mid)).toBe(false);
    expect(durationMap.has(root)).toBe(false);
  });
});

describe('attributeStageDurationToPlanInclusive', () => {
  it('sums a node\'s own share plus every descendant\'s, within one segment', () => {
    // scan(50ms) -> filter(30ms) -> agg(20ms), one segment (no Exchange), one stage of 100ms wall time
    const scan = node('Scan parquet', [], [{ name: 'time', value: 50, metricType: 'timing' }]);
    const filter = node('Filter', [scan], [{ name: 'time', value: 30, metricType: 'timing' }]);
    const agg = node('HashAggregate', [filter], [{ name: 'time', value: 20, metricType: 'timing' }]);
    const stagesById = new Map([[1, { submittedAt: 0, completedAt: 100 }]]);

    const exclusive = attributeStageDurationToPlan(agg, stagesById, { stageIds: [1] });
    expect(exclusive.get(agg)).toBe(20);
    expect(exclusive.get(filter)).toBe(30);
    expect(exclusive.get(scan)).toBe(50);

    const inclusive = attributeStageDurationToPlanInclusive(agg, stagesById, { stageIds: [1] });
    expect(inclusive.get(agg)).toBe(100); // 20 + 30 + 50
    expect(inclusive.get(filter)).toBe(80); // 30 + 50
    expect(inclusive.get(scan)).toBe(50); // leaf: no descendants
  });

  it('does not sum across a segment boundary (an Exchange write half stops the inclusive sum)', () => {
    const scan = node('Scan parquet', [], [{ name: 'time', value: 50, metricType: 'timing' }]);
    const write = { ...node('Exchange', [scan], [{ name: 'time', value: 40, metricType: 'timing' }]), exchangeRole: 'write' };
    const read = { ...node('Exchange', [write], []), exchangeRole: 'read' };
    const join = node('SortMergeJoin', [read], [{ name: 'time', value: 10, metricType: 'timing' }]);
    const stagesById = new Map([[1, { submittedAt: 0, completedAt: 90 }], [2, { submittedAt: 90, completedAt: 180 }]]);

    const inclusive = attributeStageDurationToPlanInclusive(join, stagesById, { stageIds: [2, 1] });
    // join+read are one segment (deepest-first zip picks stage 1 for the
    // scan+write segment, stage 2 for the join+read segment); join's
    // inclusive sum must not reach across the write boundary into scan.
    expect(inclusive.get(write)).toBe(90); // 40 + 50, same segment as scan
    expect(inclusive.get(join)).toBe(90);
    expect(inclusive.get(read)).toBe(0);
  });

  it('does not double-count a node reachable via two branches under one ancestor (diamond shape)', () => {
    const shared = node('Scan shared', [], [{ name: 'time', value: 20, metricType: 'timing' }]);
    const left = node('Filter left', [shared], [{ name: 'time', value: 10, metricType: 'timing' }]);
    const right = node('Filter right', [shared], [{ name: 'time', value: 10, metricType: 'timing' }]);
    const root = node('Union', [left, right], [{ name: 'time', value: 5, metricType: 'timing' }]);
    const stagesById = new Map([[1, { submittedAt: 0, completedAt: 45 }]]);

    const inclusive = attributeStageDurationToPlanInclusive(root, stagesById, { stageIds: [1] });
    // shared's own exclusive share (20) is counted once in root's inclusive
    // total, not twice (once via left, once via right), even though root
    // reaches it via two distinct branches.
    expect(inclusive.get(shared)).toBe(20);
    expect(inclusive.get(left)).toBe(30);  // 10 (left's own) + 20 (shared)
    expect(inclusive.get(right)).toBe(30); // 10 (right's own) + 20 (shared)
    expect(inclusive.get(root)).toBe(45);  // 5 (root's own) + 10 (left) + 10 (right) + 20 (shared, once)
  });

  it('returns an empty map for a null tree or no stageIds, same as the exclusive variant', () => {
    expect(attributeStageDurationToPlanInclusive(null, new Map(), { stageIds: [1] }).size).toBe(0);
    expect(attributeStageDurationToPlanInclusive(node('X'), new Map(), { stageIds: [] }).size).toBe(0);
  });
});
