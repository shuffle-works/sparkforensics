// Approximate stage wall-time back to plan operators, splitting the tree at
// Exchange boundaries into segments and zipping segments (deepest-first) to
// submission-ordered stage IDs. No exact ground truth exists in Spark's event
// model: this is inference.
import { walkPlanTree } from './plan-tree-walk.ts';
import type { PlanNode } from './types.ts';

type SegmentTopology = Map<number, { parentIndex: number | null; depth: number; traversalOrder: number }>;

function timingMs(node: PlanNode): number | null {
  for (const m of (node.metrics ?? [])) {
    if (m.metricType === 'timing') return m.value;
    if (m.metricType === 'nsTiming') return m.value / 1e6;
  }
  for (const m of (node.metrics ?? [])) {
    if (/time/i.test(m.name) && typeof m.value === 'number') return m.value;
  }
  return null;
}

// Group nodes into connected components after cutting each Exchange -> child
// boundary. Component ids are stable pre-order identities only; depth,
// traversal order, and parent relationships live in segmentTopology so no
// consumer has to infer plan topology from an id's numeric value. A fresh id
// is required for every cut: sibling producer branches at the same depth are
// separate components, not one shared "depth" segment.
export function computeSegments(planTree: PlanNode | null): {
  segments: PlanNode[][];
  segOf: Map<PlanNode, number>;
  segmentTopology: SegmentTopology;
} {
  const segments: PlanNode[][] = [];
  const segOf = new Map<PlanNode, number>();
  const segmentTopology: SegmentTopology = new Map();
  if (!planTree) return { segments, segOf, segmentTopology };
  let nextSegment = 1;
  let nextTraversalOrder = 0;
  walkPlanTree(planTree, (node, parent) => {
    let seg: number;
    if (!parent) {
      seg = 0;
      segmentTopology.set(seg, { parentIndex: null, depth: 0, traversalOrder: nextTraversalOrder++ });
    } else if (parent.exchangeRole === 'read') {
      const parentIndex = segOf.get(parent)!;
      seg = nextSegment++;
      segmentTopology.set(seg, {
        parentIndex,
        depth: segmentTopology.get(parentIndex)!.depth + 1,
        traversalOrder: nextTraversalOrder++,
      });
    } else {
      seg = segOf.get(parent)!;
    }
    segOf.set(node, seg);
    (segments[seg] ??= []).push(node);
  }, { dedupe: true });
  return { segments, segOf, segmentTopology };
}

// Deepest component executes first; equal-depth components retain plan
// traversal order. Earliest-submitted stage is first. Zips them positionally,
// truncating to whichever list is shorter: a component or stage past the
// shorter length's cutoff has no pair and is simply absent from `pairs`.
export function zipSegmentsToStages(
  segments: PlanNode[][],
  stagesById: Map<number, { submittedAt?: number; completedAt?: number }>,
  stageIds: number[],
  segmentTopology: SegmentTopology,
): {
  orderedSegments: unknown[];
  orderedStages: unknown[];
  pairs: Array<{ segmentIndex: number; stageId: number; nodes: PlanNode[]; stage: unknown }>;
} {
  const orderedSegments = segments.filter(Boolean).map((nodes, i) => ({
    i,
    nodes,
    ...segmentTopology.get(i)!,
  })).sort((a, b) => b.depth - a.depth || a.traversalOrder - b.traversalOrder);
  const orderedStages = [...stageIds]
    .map(id => ({ id, s: stagesById.get(id) }))
    .filter((x): x is { id: number; s: { submittedAt?: number; completedAt?: number } } => Boolean(x.s))
    .sort((a, b) => a.s.submittedAt! - b.s.submittedAt!);

  const n = Math.min(orderedSegments.length, orderedStages.length);
  const pairs: Array<{ segmentIndex: number; stageId: number; nodes: PlanNode[]; stage: unknown }> = [];
  for (let k = 0; k < n; k++) {
    pairs.push({
      segmentIndex: orderedSegments[k].i,
      stageId: orderedStages[k].id,
      nodes: orderedSegments[k].nodes,
      stage: orderedStages[k].s,
    });
  }
  return { orderedSegments, orderedStages, pairs };
}

function componentDistance(fromIndex: number, toIndex: number, segmentTopology: SegmentTopology): number {
  const fromAncestors = new Map<number, number>();
  let current: number | null = fromIndex;
  let distance = 0;
  while (current != null) {
    fromAncestors.set(current, distance++);
    current = segmentTopology.get(current)?.parentIndex ?? null;
  }

  current = toIndex;
  distance = 0;
  while (current != null) {
    const fromDistance = fromAncestors.get(current);
    if (fromDistance != null) return fromDistance + distance;
    current = segmentTopology.get(current)?.parentIndex ?? null;
    distance++;
  }
  return Number.POSITIVE_INFINITY;
}

// Display-only: the "Stage N" label on a segment's group box. A segment past
// zipSegmentsToStages' Math.min cutoff has no timing to pair on, but the plan
// still places it structurally near a component that won a stage slot (often a
// broadcast-builder just upstream of the join consuming it). Inherit the
// nearest strictly-paired component's stage id rather than showing "Stage —".
// Distance counts parent/child edges in the component tree, not numeric id
// distance. Neighbor search is always against the ORIGINAL strict pairs, not
// other filled components, so labels don't drift through inherited-from-
// inherited guesses. Duration attribution keeps its own strict pairing and
// must never double-count one stage's wall time across two segments.
export function mapSegmentsToStagesForDisplay(
  segments: PlanNode[][],
  stagesById: Map<number, unknown>,
  stageIds: number[],
  segmentTopology: Map<number, unknown>,
): Map<number, number> {
  const typedStagesById = stagesById as Map<number, { submittedAt?: number; completedAt?: number }>;
  const typedTopology = segmentTopology as SegmentTopology;
  const { orderedSegments, pairs } = zipSegmentsToStages(segments, typedStagesById, stageIds, typedTopology);
  const map = new Map<number, number>(pairs.map((p) => [p.segmentIndex, p.stageId]));
  const pairedIndices = pairs.map((p) => p.segmentIndex);
  if (pairedIndices.length === 0) return map;

  for (const { i } of orderedSegments as { i: number }[]) {
    if (map.has(i)) continue;
    let nearest = pairedIndices[0];
    let nearestDist = componentDistance(i, nearest, typedTopology);
    for (const pi of pairedIndices) {
      const dist = componentDistance(i, pi, typedTopology);
      if (dist < nearestDist) { nearestDist = dist; nearest = pi; }
    }
    map.set(i, map.get(nearest)!);
  }
  return map;
}

function computeExclusiveSharesForPairs(
  pairs: Array<{ nodes: PlanNode[]; stage: unknown }>,
): Map<PlanNode, number> {
  const out = new Map<PlanNode, number>();
  for (const { nodes, stage } of pairs) {
    const { submittedAt, completedAt } = stage as { submittedAt: number; completedAt: number };
    const wall = Math.max(0, completedAt - submittedAt);
    const weights = nodes.map(timingMs);
    const totalTiming = weights.reduce<number>((a, w) => a + (w ?? 0), 0);
    nodes.forEach((node, idx) => {
      const share = totalTiming > 0
        ? wall * ((weights[idx] ?? 0) / totalTiming)
        : wall / nodes.length;
      out.set(node, share);
    });
  }
  return out;
}

export function attributeStageDurationToPlan(
  planTree: PlanNode | null,
  stagesById: Map<number, unknown>,
  sqlExec: { stageIds?: number[] },
): Map<PlanNode, number> {
  const stageIds = sqlExec?.stageIds ?? [];
  if (!planTree || stageIds.length === 0) return new Map();
  const { segments, segmentTopology } = computeSegments(planTree);
  const typedStagesById = stagesById as Map<number, { submittedAt?: number; completedAt?: number }>;
  const { pairs } = zipSegmentsToStages(segments, typedStagesById, stageIds, segmentTopology);
  return computeExclusiveSharesForPairs(pairs);
}

// Exclusive share plus every descendant present in the same segment's node
// list. "Same segment" is what keeps this from leaking across an Exchange
// boundary: computeSegments already cuts a new segment at each write half,
// so a node's descendants outside its own segment are simply not in
// `inSegment` and get excluded by construction.
export function attributeStageDurationToPlanInclusive(
  planTree: PlanNode | null,
  stagesById: Map<number, unknown>,
  sqlExec: { stageIds?: number[] },
): Map<PlanNode, number> {
  const stageIds = sqlExec?.stageIds ?? [];
  const out = new Map<PlanNode, number>();
  if (!planTree || stageIds.length === 0) return out;
  const { segments, segmentTopology } = computeSegments(planTree);
  const typedStagesById = stagesById as Map<number, { submittedAt?: number; completedAt?: number }>;
  const { pairs } = zipSegmentsToStages(segments, typedStagesById, stageIds, segmentTopology);
  const exclusive = computeExclusiveSharesForPairs(pairs);

  for (const { nodes } of pairs) {
    const inSegment = new Set(nodes);
    for (const node of nodes) {
      // `visited` is fresh per top-level node, not shared across the `nodes`
      // loop: a diamond-shared descendant's value, when computed while
      // suppressed by ANOTHER node's own traversal (to avoid double-counting
      // within THAT node's rollup), is not valid to reuse for the shared
      // descendant's own independent top-level entry, those are different
      // questions ("what does this contribute to node X's total" vs. "what
      // is this node's own total in isolation"). This also rules out a
      // node->total memo shared across top-level calls: a cached total
      // computed unsuppressed (as its own top-level entry) would, if reused
      // while this node is a descendant of a DIFFERENT ancestor being
      // suppressed for double-counting, smuggle a shared descendant's share
      // back in twice - see the diamond-shape regression test. Losing
      // memoization across different top-level calls is fine: these trees
      // are small and this was never a performance-critical path.
      const visited = new Set<PlanNode>();
      function inclusiveOf(n: PlanNode): number {
        if (visited.has(n)) return 0;
        visited.add(n);
        let total = exclusive.get(n) ?? 0;
        for (const child of n.children ?? []) {
          if (inSegment.has(child)) total += inclusiveOf(child);
        }
        return total;
      }
      out.set(node, inclusiveOf(node));
    }
  }
  return out;
}
