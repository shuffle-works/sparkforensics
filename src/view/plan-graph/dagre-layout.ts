import dagre, { type LayoutConfig } from '@dagrejs/dagre';
import type { PlanGraphEdge, PlanGraphNodeData } from '@sparkforensics/core/types.ts';

export interface LaidOutNode extends PlanGraphNodeData {
  position: { x: number; y: number };
}

export interface LaidOutGroup {
  id: string;
  position: { x: number; y: number };
  width: number;
  height: number;
}

export const NODE_WIDTH = 220;
export const NODE_HEIGHT = 90;
const GROUP_PADDING = 24;
const GROUP_HEADER_HEIGHT = 32;
// The stage box wraps its paired segment's plan nodes directly; that segment
// draws no box of its own. PADDING_Y leaves 64px above the nodes for the stage
// header, with room to wrap it onto a second row. PADDING_X (32px) stays small so
// the box doesn't balloon sideways, and PADDING_BOTTOM (32px) matches it, as
// nothing is painted below the nodes. HEADER stays 0: the header sits inside
// PADDING_Y.
export const STAGE_GROUP_PADDING_X = 32;
export const STAGE_GROUP_PADDING_Y = 64;
export const STAGE_GROUP_PADDING_BOTTOM = 32;
export const STAGE_GROUP_HEADER_HEIGHT = 0;

export type PlanLayoutDirection = 'RL' | 'BT';

// A layout depends only on the topology: node ids, their group, the edges and
// the direction. Flipping the duration mode, a finding refresh or returning to a
// filter or scope already laid out changes the node data but not the topology, so
// the positions are reused instead of running Dagre again (roughly 1ms per node).
// Small and recency-ordered: a graph the user left a few views ago is not worth
// holding on to.
const LAYOUT_CACHE_LIMIT = 6;
const layoutCache = new Map<string, Map<string, { x: number; y: number }>>();

function layoutCacheKey(
  nodes: PlanGraphNodeData[],
  groupIds: (string | null)[],
  edges: PlanGraphEdge[],
  direction: PlanLayoutDirection,
): string {
  const nodePart = nodes.map((node, i) => `${node.id}\u0001${groupIds[i] ?? ''}`).join('\u0002');
  const edgePart = edges.map((edge) => `${edge.source}\u0001${edge.target}`).join('\u0002');
  return `${direction}\u0003${nodePart}\u0003${edgePart}`;
}

/** Drops every cached layout; tests use it to start from a cold cache. */
export function clearLayoutCache(): void {
  layoutCache.clear();
}

type LayoutOptions = { groupOf?: (node: PlanGraphNodeData) => string | null; direction?: PlanLayoutDirection };

/** What a layout depends on, reduced to plain data so it can cross to a worker. */
export interface LayoutJob {
  key: string;
  nodeIds: string[];
  groupIds: (string | null)[];
  edges: { source: string; target: string }[];
  direction: PlanLayoutDirection;
  compound: boolean;
}

export type LayoutPositions = Map<string, { x: number; y: number }>;

function describeLayout(nodes: PlanGraphNodeData[], edges: PlanGraphEdge[], opts: LayoutOptions): LayoutJob {
  const direction = opts.direction ?? 'RL';
  const groupIds = nodes.map((node) => opts.groupOf?.(node) ?? null);
  return {
    key: layoutCacheKey(nodes, groupIds, edges, direction),
    nodeIds: nodes.map((node) => node.id),
    groupIds,
    edges: edges.map((edge) => ({ source: edge.source, target: edge.target })),
    direction,
    compound: Boolean(opts.groupOf),
  };
}

function rememberLayout(key: string, positions: LayoutPositions): void {
  layoutCache.delete(key);
  // Drops the least recently used entry first.
  if (layoutCache.size >= LAYOUT_CACHE_LIMIT) layoutCache.delete(layoutCache.keys().next().value as string);
  layoutCache.set(key, positions);
}

/** The cache key and plain-data description of a layout, or null when it is
 * already cached (nothing to compute). Used to run the layout off the main thread. */
export function pendingLayoutJob(
  nodes: PlanGraphNodeData[],
  edges: PlanGraphEdge[],
  opts: LayoutOptions = {},
): LayoutJob | null {
  const job = describeLayout(nodes, edges, opts);
  return layoutCache.has(job.key) ? null : job;
}

/** Stores a layout computed elsewhere (the layout worker) so the next
 * `layoutWithDagre` for the same topology is a cache hit. */
export function storeLayout(key: string, positions: LayoutPositions): void {
  rememberLayout(key, positions);
}

export function layoutWithDagre(
  nodes: PlanGraphNodeData[],
  edges: PlanGraphEdge[],
  opts: LayoutOptions = {},
): LaidOutNode[] {
  const job = describeLayout(nodes, edges, opts);
  let positions = layoutCache.get(job.key);
  if (!positions) positions = runDagre(job);
  // Re-inserts a hit as well, so the least recently used entry is the first to go.
  rememberLayout(job.key, positions);
  const placed = positions;
  return nodes.map((node) => {
    const pos = placed.get(node.id)!;
    return { ...node, position: { x: pos.x, y: pos.y } };
  });
}

// Dagre can order three overlapping groups in a cycle, drop them from the next
// sweep, and leave two nodes on one (rank, order) slot, which makes `dagre.layout`
// throw. The ordering pass below pins the group order and separates shared slots
// (docs-site/contributor-guide/architecture/drill-down/plan-graph.md, "Layout
// ordering and cost").

type DagreGraph = InstanceType<typeof dagre.graphlib.Graph>;

function hasSharedSlot(graph: DagreGraph): boolean {
  const slots = new Set<string>();
  for (const id of graph.nodes()) {
    if (graph.children(id).length) continue;
    const { rank, order } = graph.node(id) as { rank: number; order: number };
    const key = `${rank}:${order}`;
    if (slots.has(key)) return true;
    slots.add(key);
  }
  return false;
}

/** One fixed left-to-right order for every pair of groups that share a rank. A
 * total order has no cycle, so Dagre keeps every group in every sweep. Groups
 * that never share a rank need no constraint. */
function groupOrderConstraints(graph: DagreGraph, groupRank: Map<string, number>): { left: string; right: string }[] {
  const spans = [...groupRank.keys()]
    .sort((a, b) => groupRank.get(a)! - groupRank.get(b)!)
    .map((group) => ({ group, ...(graph.node(group) as { minRank: number; maxRank: number }) }));
  return spans.flatMap((left, i) =>
    spans
      .slice(i + 1)
      .filter((right) => left.minRank <= right.maxRank && right.minRank <= left.maxRank)
      .map((right) => ({ left: left.group, right: right.group })),
  );
}

/** Gives every node of a rank its own order: nodes that share a slot keep their
 * relative position and move to consecutive slots. The pinned pass can still leave
 * a shared slot, because the constraints Dagre adds from the order it observed
 * can contradict the fixed order through the groups' border and edge nodes. */
function separateSharedSlots(graph: DagreGraph): void {
  const ranks = new Map<number, { id: string; order: number }[]>();
  for (const id of graph.nodes()) {
    if (graph.children(id).length) continue;
    const { rank, order } = graph.node(id) as { rank: number; order: number };
    ranks.set(rank, [...(ranks.get(rank) ?? []), { id, order }]);
  }
  for (const members of ranks.values()) {
    // Array.prototype.sort is stable, so ties keep the graph's node order.
    members.sort((a, b) => a.order - b.order).forEach(({ id }, slot) => {
      (graph.node(id) as { order: number }).order = slot;
    });
  }
}

/** Dagre's ordering pass. When two nodes end on one slot, orders again with the
 * groups pinned to one fixed order, then separates any nodes still sharing a slot.
 * A graph whose first pass has no shared slot is ordered exactly as by default. */
function orderGroups(groupRank: Map<string, number>): NonNullable<LayoutConfig['customOrder']> {
  return (graph, order) => {
    order(graph, {});
    if (!hasSharedSlot(graph)) return;
    order(graph, { constraints: groupOrderConstraints(graph, groupRank) });
    if (hasSharedSlot(graph)) separateSharedSlots(graph);
  };
}

/** The Dagre pass itself. Pure: the layout worker runs it on the same job the
 * main thread would, so both produce identical positions. */
export function runDagre({ nodeIds, groupIds, edges, direction, compound }: LayoutJob): LayoutPositions {
  const g = new dagre.graphlib.Graph({ compound });
  // RL: PlanGraphEdge.source is the parent/consumer, .target its child/producer.
  // Dagre places an edge's source at the higher-rank end, so 'RL' puts
  // reads/scans on the left and the root write on the right, matching the plan's
  // left-to-right data flow.
  //
  // nodesep (gap between vertically-adjacent nodes in RL) is at least twice
  // STAGE_GROUP_PADDING_Y, or stacked stage boxes overlap. Unmatched segment
  // boxes use the smaller GROUP_PADDING and already clear it.
  //
  // ranker 'tight-tree' instead of 'network-simplex', which is several times
  // slower on a compound graph; plans are trees, so it assigns the same ranks
  // (calibration in the plan-graph.md page). 'longest-path' places degenerately.
  //
  // 'BT' is the same arrangement on a phone-width canvas. The clearances swap
  // axes: ranksep takes the 2×STAGE_GROUP_PADDING_Y floor, and nodesep needs
  // 2×STAGE_GROUP_PADDING_X plus a gap.
  g.setGraph(
    direction === 'BT'
      ? { rankdir: 'BT', nodesep: STAGE_GROUP_PADDING_X * 2 + 24, ranksep: STAGE_GROUP_PADDING_Y * 2, ranker: 'tight-tree' }
      : { rankdir: 'RL', nodesep: STAGE_GROUP_PADDING_Y * 2, ranksep: 60, ranker: 'tight-tree' },
  );
  g.setDefaultEdgeLabel(() => ({}));

  const groups = new Set<string>();
  for (const group of groupIds) if (group) groups.add(group);
  for (const group of groups) g.setNode(group, {});

  nodeIds.forEach((id, i) => {
    g.setNode(id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    const group = groupIds[i];
    if (group) g.setParent(id, group);
  });
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g, compound ? { customOrder: orderGroups(new Map([...groups].map((group, i) => [group, i]))) } : undefined);

  const positions: LayoutPositions = new Map();
  for (const id of nodeIds) {
    const pos = g.node(id);
    positions.set(id, { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 });
  }
  return positions;
}

// Derives each group's box from its members' own laid-out rectangles rather than
// dagre's internal cluster bookkeeping, keeping this independent of
// layoutWithDagre's internals.
export function computeGroupBounds(
  laidOutNodes: LaidOutNode[],
  groupOf: (node: PlanGraphNodeData) => string | null,
  opts: { paddingX?: number; paddingY?: number; paddingBottom?: number; headerHeight?: number } = {},
): LaidOutGroup[] {
  const paddingX = opts.paddingX ?? GROUP_PADDING;
  const paddingY = opts.paddingY ?? GROUP_PADDING;
  const paddingBottom = opts.paddingBottom ?? paddingY;
  const headerHeight = opts.headerHeight ?? GROUP_HEADER_HEIGHT;
  const bounds = new Map<string, { minX: number; minY: number; maxX: number; maxY: number }>();
  for (const node of laidOutNodes) {
    const groupId = groupOf(node);
    if (!groupId) continue;
    const x0 = node.position.x;
    const y0 = node.position.y;
    const x1 = x0 + NODE_WIDTH;
    const y1 = y0 + NODE_HEIGHT;
    const existing = bounds.get(groupId);
    if (!existing) {
      bounds.set(groupId, { minX: x0, minY: y0, maxX: x1, maxY: y1 });
    } else {
      existing.minX = Math.min(existing.minX, x0);
      existing.minY = Math.min(existing.minY, y0);
      existing.maxX = Math.max(existing.maxX, x1);
      existing.maxY = Math.max(existing.maxY, y1);
    }
  }
  return [...bounds.entries()].map(([id, b]) => ({
    id,
    position: { x: b.minX - paddingX, y: b.minY - paddingY - headerHeight },
    width: (b.maxX - b.minX) + paddingX * 2,
    height: (b.maxY - b.minY) + paddingY + paddingBottom + headerHeight,
  }));
}

// Bounds every group across candidate layouts, preferring the earliest candidate
// with a member for a given group id and consulting later ones only for groups
// the earlier missed. Lets a caller pass a compact visible-node layout as primary
// (box hugs what's on screen) while a fully-filtered group still gets a box from
// a coarser fallback layout.
export function computeGroupBoundsWithFallback(
  groupOf: (node: PlanGraphNodeData) => string | null,
  layoutCandidates: LaidOutNode[][],
  opts: { paddingX?: number; paddingY?: number; paddingBottom?: number; headerHeight?: number } = {},
): LaidOutGroup[] {
  const seen = new Set<string>();
  const result: LaidOutGroup[] = [];
  for (const laidOutNodes of layoutCandidates) {
    const remaining = (node: PlanGraphNodeData) => {
      const id = groupOf(node);
      return id && !seen.has(id) ? id : null;
    };
    for (const group of computeGroupBounds(laidOutNodes, remaining, opts)) {
      seen.add(group.id);
      result.push(group);
    }
  }
  return result;
}
