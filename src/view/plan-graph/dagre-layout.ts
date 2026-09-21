import dagre from '@dagrejs/dagre';
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
// Outer stage box must strictly contain a segment box, which reserves
// GROUP_PADDING + GROUP_HEADER_HEIGHT = 56px above its members and GROUP_PADDING
// (24px) elsewhere, so both stage paddings exceed those: PADDING_Y (>56) leaves
// 8px top / 40px bottom margin; PADDING_X (>24) stays near the floor so the box
// doesn't balloon sideways. HEADER stays 0 (the stage box paints no header row;
// its showOwnFindings fallback sizes from the whole fallback graph, so no chip
// row can collide).
export const STAGE_GROUP_PADDING_X = 32;
export const STAGE_GROUP_PADDING_Y = 64;
export const STAGE_GROUP_HEADER_HEIGHT = 0;

export function layoutWithDagre(
  nodes: PlanGraphNodeData[],
  edges: PlanGraphEdge[],
  opts: { groupOf?: (node: PlanGraphNodeData) => string | null } = {},
): LaidOutNode[] {
  const g = new dagre.graphlib.Graph({ compound: Boolean(opts.groupOf) });
  // RL: PlanGraphEdge.source is the parent/consumer, .target its child/producer.
  // Dagre places an edge's source at the higher-rank end, so 'RL' puts
  // reads/scans on the left and the root write on the right, matching the plan's
  // left-to-right data flow.
  //
  // nodesep is the gap between vertically-adjacent nodes (same rank, RL layout).
  // It must be at least twice STAGE_GROUP_PADDING_Y: the full-plan view wraps
  // each stage in an outer box that reserves that padding above and below its
  // members, so two vertically-stacked stages whose members sit closer than
  // 2×padding would get outer boxes that overlap into each other (they did, by
  // ~48px, before this floor). Segment boxes use the smaller GROUP_PADDING and
  // already clear it.
  //
  // ranker 'tight-tree' instead of dagre's default 'network-simplex': on a
  // compound (grouped) graph, network-simplex's rank-assignment iterates
  // expensively (a 400-node plan measured ~1600ms vs ~500ms for tight-tree,
  // ~3x), and worse as the plan grows. Every plan is a tree plus the Exchange
  // read/write split, and tight-tree assigns the same ranks a tree wants, so
  // the arrangement and grouping are preserved while the cost drops sharply.
  // ('longest-path' is faster still but produces degenerate placements here.)
  g.setGraph({ rankdir: 'RL', nodesep: STAGE_GROUP_PADDING_Y * 2, ranksep: 60, ranker: 'tight-tree' });
  g.setDefaultEdgeLabel(() => ({}));

  const groups = new Set<string>();
  if (opts.groupOf) {
    for (const node of nodes) {
      const group = opts.groupOf(node);
      if (group) groups.add(group);
    }
    for (const group of groups) g.setNode(group, {});
  }

  for (const node of nodes) {
    g.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
    const group = opts.groupOf?.(node);
    if (group) g.setParent(node.id, group);
  }
  for (const edge of edges) {
    g.setEdge(edge.source, edge.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const pos = g.node(node.id);
    return { ...node, position: { x: pos.x - NODE_WIDTH / 2, y: pos.y - NODE_HEIGHT / 2 } };
  });
}

// Derives each group's box from its members' own laid-out rectangles rather than
// dagre's internal cluster bookkeeping, keeping this independent of
// layoutWithDagre's internals.
export function computeGroupBounds(
  laidOutNodes: LaidOutNode[],
  groupOf: (node: PlanGraphNodeData) => string | null,
  opts: { paddingX?: number; paddingY?: number; headerHeight?: number } = {},
): LaidOutGroup[] {
  const paddingX = opts.paddingX ?? GROUP_PADDING;
  const paddingY = opts.paddingY ?? GROUP_PADDING;
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
    height: (b.maxY - b.minY) + paddingY * 2 + headerHeight,
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
  opts: { paddingX?: number; paddingY?: number; headerHeight?: number } = {},
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
