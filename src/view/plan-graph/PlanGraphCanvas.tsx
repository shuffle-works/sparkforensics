import { useEffect, useMemo, useRef, useState } from 'react';
import { ReactFlow, MiniMap, Background, Panel, useReactFlow, ReactFlowProvider, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { layoutWithDagre, computeGroupBoundsWithFallback, NODE_WIDTH, NODE_HEIGHT, STAGE_GROUP_PADDING_X, STAGE_GROUP_PADDING_Y, STAGE_GROUP_HEADER_HEIGHT } from './dagre-layout';
import { PlanGraphNode } from './PlanGraphNode';
import { PlanGraphNodeDetail } from './PlanGraphNodeDetail';
import { PlanGraphLegend } from './PlanGraphLegend';
import { PlanGraphControlRail } from './PlanGraphControlRail';
import { planGraphMiniMapNodeColor } from './plan-graph-minimap';
import { PlanGraphSegmentGroupNode } from './PlanGraphSegmentGroupNode';
import { PlanGraphStageGroupNode } from './PlanGraphStageGroupNode';
import { PlanGraphExchangeEdge } from './PlanGraphExchangeEdge';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { byImpactDesc } from '@/view/impact-sort';
import type { Finding, PlanGraphDurationMode, PlanGraphEdge, PlanGraphFilterMode, PlanGraphModel, PlanGraphNodeData, StageId } from '@sparkforensics/core/types.ts';

const nodeTypes = {
  planNode: PlanGraphNode,
  segmentGroup: PlanGraphSegmentGroupNode,
  stageGroup: PlanGraphStageGroupNode,
};

const edgeTypes = {
  exchange: PlanGraphExchangeEdge,
};

// Paint order, all above React Flow's edge layer (z 0): outer stage box, then
// inner segment box, then the plan nodes on top. Keeping the group boxes above
// the edges (rather than the old negative z-index behind them) stops a routed
// edge from painting over a box's finding chips; the boxes' fills are
// translucent, so an edge crossing a box still reads through.
const STAGE_GROUP_Z = 1;
const SEGMENT_GROUP_Z = 2;
const PLAN_NODE_Z = 3;

// Node<T> requires T extends Record<string, unknown>, which PlanGraphNodeData (a
// closed interface) doesn't satisfy; read data through this cast so `nodes` stays
// the plain Node[] that <ReactFlow nodes={...}> expects.
type PlanGraphFlowNodeData = PlanGraphNodeData & { durationSharePct: number | null };
const flowData = (n: Node) => n.data as unknown as PlanGraphFlowNodeData;

/** A recenter request from a paired-node jump. `token` monotonically increments
 * per request so a repeat jump to the same node still fires the effect; token 0
 * is the initial no-op. */
export type CenterRequest = { nodeId: string | null; token: number };

// Shared fit options for the initial mount and every programmatic re-fit, so the
// graph fills the canvas consistently instead of landing as a small strip in a
// large empty viewport. Tighter-than-default padding (0.1) recovers the wasted
// margin; maxZoom lets a small plan (a few nodes) enlarge enough to read while
// still capping a one-node plan short of a grotesque blow-up.
const FIT_OPTIONS = { padding: 0.06, maxZoom: 1.75 } as const;

function ViewportAutoFit({ resizeTick, fitSignal, centerRequest }: { resizeTick: number; fitSignal: number; centerRequest?: CenterRequest }) {
  const { fitView, setCenter, getNode } = useReactFlow();

  // Recenter on a paired-node jump (the detail card's "Jump to write/read
  // half"). Token 0 is the initial value, so the mount never pans. Uses the
  // node's laid-out position like the control rail's jump; falls back to a
  // by-id fitView when the node isn't in the store yet (e.g. the tick right
  // after a scope expand brought the partner into view).
  useEffect(() => {
    if (!centerRequest || centerRequest.token === 0 || !centerRequest.nodeId) return;
    const target = getNode(centerRequest.nodeId);
    if (target) setCenter(target.position.x, target.position.y, { zoom: 1, duration: 300 });
    else fitView({ nodes: [{ id: centerRequest.nodeId }], duration: 300, maxZoom: 1 });
  }, [centerRequest, setCenter, getNode, fitView]);

  useEffect(() => {
    const onResize = () => fitView({ duration: 200, ...FIT_OPTIONS });
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitView]);

  // The docs panel resizes this container via CSS, not the window, so `resize`
  // above never fires for it; resizeTick (a ResizeObserver on the outer row)
  // covers that. It sits on the outer row, not the canvas wrapper, so opening
  // the docked inspector (which shrinks the canvas but not the row) does not
  // fire it and reset the user's pan/zoom. tick 0 is the initial measurement,
  // already handled by the fitView prop on <ReactFlow>.
  useEffect(() => {
    if (resizeTick === 0) return;
    fitView({ duration: 200, ...FIT_OPTIONS });
  }, [resizeTick, fitView]);

  // Re-fit when the route flips scope (Expand to full plan / Back to segment
  // view): the new graph is a very different size, so keeping the old pan/zoom
  // would leave the user zoomed into a corner. Signal 0 is the initial value,
  // already covered by the fitView prop on <ReactFlow>.
  useEffect(() => {
    if (fitSignal === 0) return;
    fitView({ duration: 300, ...FIT_OPTIONS });
  }, [fitSignal, fitView]);

  return null;
}

/** Fires on every container resize after the first (initial) measurement. */
function useResizeTick() {
  const ref = useRef<HTMLDivElement>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let isInitialMeasurement = true;
    const observer = new ResizeObserver(() => {
      if (isInitialMeasurement) {
        isInitialMeasurement = false;
        return;
      }
      setTick((t) => t + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, tick };
}

function findingsForStage(findings: Finding[], stageId: StageId): Finding[] {
  return findings.filter((finding) => finding.stageId === stageId || finding.stageIds?.includes(stageId));
}

export function PlanGraphCanvas({
  model, showMiniMap, findings = [], stageId, segmentStageIds, visibleNodeIds, visibleEdges, onSelectStage,
  selectedNodeId = null, onSelectNode,
  onJumpToPaired,
  centerRequest,
  fitSignal = 0,
  filterMode = 'basic', onFilterModeChange = () => {}, hiddenCount = 0,
  durationMode = 'exclusive', onDurationModeChange = () => {},
}: {
  model: PlanGraphModel;
  showMiniMap: boolean;
  findings?: Finding[];
  stageId: StageId;
  segmentStageIds?: Map<number, number>;
  /** Limits only foreground plan nodes; layout and group boxes use all model nodes. */
  visibleNodeIds?: Set<string>;
  /** Foreground edges after category filtering/collapse; defaults to all model edges. */
  visibleEdges?: PlanGraphEdge[];
  /** Full-scope only (stageGroup nodes don't exist otherwise): jump focus to a different stage's segment view. */
  onSelectStage?: (stageId: StageId) => void;
  /** Id of the plan node whose detail inspector is open, or null when none.
   * Owned by the route so Escape can close the inspector before the whole route. */
  selectedNodeId?: string | null;
  onSelectNode?: (id: string | null) => void;
  /** Selects and recenters the paired half of a split Exchange node, from the
   * detail card. The route owns the cross-scope expand this may require. */
  onJumpToPaired?: (pairedNodeId: string) => void;
  /** A paired-node jump's recenter request; the route bumps its token per jump. */
  centerRequest?: CenterRequest;
  /** Incremented by the route on an Expand/Back scope switch to trigger a
   * fit-to-view; 0 is the initial value (no fit beyond the mount-time one). */
  fitSignal?: number;
  /** Node filter + duration settings, surfaced from the control rail's Settings
   * popover (they used to live in the topbar). The route owns the state. */
  filterMode?: PlanGraphFilterMode;
  onFilterModeChange?: (mode: PlanGraphFilterMode) => void;
  hiddenCount?: number;
  durationMode?: PlanGraphDurationMode;
  onDurationModeChange?: (mode: PlanGraphDurationMode) => void;
}) {
  const { flowNodes, flowEdges } = useMemo(() => {
    // Sum `exclusiveDurationShare` (a true, non-overlapping partition of each
    // stage's wall time), not `durationShare` (the mode-selected value shown
    // on each node): under 'inclusive' mode `durationShare` double/triple-
    // counts a node's own time into every ancestor, so summing it directly
    // would make this total balloon by tree depth and distort every node's
    // percentage. Falls back to `durationShare` for hand-built fixtures
    // (tests) that don't set the exclusive field separately.
    const totalDuration = model.nodes.reduce((sum, n) => sum + (n.exclusiveDurationShare ?? n.durationShare ?? 0), 0);
    const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;
    // The outer per-real-stage box only appears in the full-plan view: the
    // single-stage view already shows one segment box for the one stage in view,
    // so a nested layer would just duplicate its "Stage N" label.
    const showStageGroup = model.scope === 'full';
    const stageGroupOf = (n: PlanGraphNodeData) => {
      const sId = segmentStageIds?.get(n.segmentIndex);
      return sId != null ? `stage-${sId}` : null;
    };

    // Foreground nodes/edges laid out on their own compact subgraph so filtering
    // closes gaps instead of stranding visible nodes. With no filter this is the
    // whole model, so it doubles as the fallback layout below (single pass).
    const laidOutVisible = visibleNodeIds
      ? layoutWithDagre(model.nodes.filter((n) => visibleNodeIds.has(n.id)), visibleEdges ?? model.edges, { groupOf })
      : layoutWithDagre(model.nodes, model.edges, { groupOf });

    // A fully-filtered segment/stage (every member hidden) still gets a box,
    // positioned from a full-model layout fallback. That compound Dagre pass
    // over every node is the most expensive thing this memo does (roughly the
    // visible pass again, but over the larger unfiltered set), so run it only
    // when a group is genuinely missing from the visible layout. In a normal
    // full open each Exchange-bounded segment keeps its exchange node under the
    // basic filter, so nothing is missing and this pass is skipped entirely.
    const coveredSegments = new Set(laidOutVisible.map(groupOf));
    const coveredStages = showStageGroup
      ? new Set(laidOutVisible.map(stageGroupOf).filter((id): id is string => id != null))
      : null;
    const needsFullFallback =
      model.nodes.some((n) => !coveredSegments.has(groupOf(n))) ||
      (coveredStages != null &&
        model.nodes.some((n) => {
          const id = stageGroupOf(n);
          return id != null && !coveredStages.has(id);
        }));
    const laidOutFull = needsFullFallback
      ? layoutWithDagre(model.nodes, model.edges, { groupOf })
      : laidOutVisible;

    const planNodes: Node[] = laidOutVisible.map((n) => {
      const durationSharePct = n.durationShare != null && totalDuration > 0
        ? Math.round((n.durationShare / totalDuration) * 100)
        : null;
      const ariaLabel = n.splitRole === 'read'
        ? `${n.label}, paired: see write half`
        : [n.label, n.operatorDetail, n.primaryMetric, durationSharePct != null ? `${durationSharePct}% of the plan's total stage duration` : null]
            .filter(Boolean)
            .join(', ');
      return {
        id: n.id,
        type: 'planNode',
        position: n.position,
        // Read-only graph: no node drag (also keeps xyflow's drag handler off
        // each node, which otherwise throws under jsdom on click).
        draggable: false,
        // Layer order (see the group boxes below): boxes sit above the edge
        // layer so their finding chips aren't painted over by a routed edge,
        // and plan nodes sit above the boxes.
        zIndex: PLAN_NODE_Z,
        // MiniMap reads dimensions off the user node object; this view never
        // passes onNodesChange, so the ResizeObserver's dimension events have
        // nowhere to write back. Seed measured upfront or nodes never report a
        // size to it.
        measured: { width: NODE_WIDTH, height: NODE_HEIGHT },
        ariaLabel,
        // Announce as a button, not xyflow's default 'group': a plan node is an
        // activatable control that opens the detail inspector (keyboard open is
        // wired on the container below).
        ariaRole: 'button',
        data: { ...n, durationSharePct },
      };
    });

    // Group boxes are plain background nodes in the members' coordinate space
    // (not xyflow parent/child nesting; this view is read-only), layered under
    // the plan nodes but above the edges (see the *_Z constants). Bounds come
    // from the compact layout when a segment still has a visible member; a
    // fully-filtered segment still gets a box sized from the full-model layout.
    const groupNodes: Node[] = computeGroupBoundsWithFallback(groupOf, [laidOutVisible, laidOutFull]).map((group) => {
      const segmentIndex = Number(group.id.replace('segment-', ''));
      // Duration/heat totals reflect the segment's real, unfiltered content;
      // filtering declutters the view, it doesn't change what happened. Reads
      // model.nodes (full membership, positions irrelevant here) rather than a
      // laid-out set, so it stays correct even when the fallback layout above
      // is skipped and laidOutFull aliases the filtered laidOutVisible.
      const membersInGroup = model.nodes.filter((n) => groupOf(n) === group.id);
      // Same rationale as `totalDuration` above: this label is meant to read
      // as the segment's real wall time, which only the exclusive partition
      // gives; summing the mode-selected `durationShare` would show an
      // inflated, mode-dependent number under 'inclusive'.
      const groupDuration = membersInGroup.reduce((sum, n) => sum + (n.exclusiveDurationShare ?? n.durationShare ?? 0), 0);
      const hasAnyDuration = membersInGroup.some((n) => n.durationShare != null);
      const groupStageId = segmentStageIds?.get(segmentIndex) ?? null;
      // Findings render inline in this box's header row when zipped to a real
      // stage; the outer stage box only paints its own copy as a fallback for a
      // stage with no matching segment (see matchedStageIds), so there's one copy.
      const segmentFindings = groupStageId != null ? findingsForStage(findings, groupStageId) : [];
      return {
        id: group.id,
        type: 'segmentGroup',
        position: group.position,
        draggable: false,
        selectable: false,
        // Decorative background layer: keep it out of the tab order so keyboard
        // users step between operators, not through empty group boxes.
        focusable: false,
        zIndex: SEGMENT_GROUP_Z,
        style: { width: group.width, height: group.height },
        measured: { width: group.width, height: group.height },
        data: {
          width: group.width,
          height: group.height,
          stageId: groupStageId,
          durationLabel: hasAnyDuration ? formatDuration(groupDuration) : null,
          findings: segmentFindings,
        },
      };
    });

    // Stage ids whose findings a segment box already carries inline, so the outer
    // stage box knows when it's the only place left to show them.
    const matchedStageIds = new Set(
      groupNodes
        .map((g) => (g.data as { stageId: number | null }).stageId)
        .filter((id): id is number => id != null),
    );

    // Outer group layer: one solid tinted box per stage wrapping every segment
    // box zipped to it, so a stage split across Exchange-bounded segments reads as
    // one unit. Wider padding/header keeps the outer box strictly containing its
    // nested segment box(es); see the padding constants for the math.
    // (showStageGroup and stageGroupOf are defined at the top of the memo, next
    // to the layout passes that need them.)
    const stageGroupNodes: Node[] = showStageGroup
      ? (() => {
          const groupOptions = {
            paddingX: STAGE_GROUP_PADDING_X,
            paddingY: STAGE_GROUP_PADDING_Y,
            headerHeight: STAGE_GROUP_HEADER_HEIGHT,
          };
          const stageGroups = computeGroupBoundsWithFallback(stageGroupOf, [laidOutVisible, laidOutFull], groupOptions);
          const focalGroupId = `stage-${stageId}`;
          // Segment/stage zipping can leave the focal stage unmapped when its
          // segment loses the Math.min(segments, stages) pairing slot; add a focal
          // finding target around the fallback graph so findings and "Next
          // problem" stay reachable.
          if (findingsForStage(findings, stageId).length > 0 && !stageGroups.some((group) => group.id === focalGroupId)) {
            const [focalGroup] = computeGroupBoundsWithFallback(() => focalGroupId, [laidOutVisible, laidOutFull], groupOptions);
            if (focalGroup) stageGroups.push(focalGroup);
          }
          return stageGroups.map((group) => {
            const groupStageId = Number(group.id.replace('stage-', ''));
            return {
              id: group.id,
              type: 'stageGroup',
              position: group.position,
              draggable: false,
              selectable: false,
              // Wrapper is decorative; its inner "Focus stage N" button is the
              // real, separately-focusable control, so keep the wrapper itself
              // out of the tab order.
              focusable: false,
              zIndex: STAGE_GROUP_Z,
              style: { width: group.width, height: group.height },
              measured: { width: group.width, height: group.height },
              data: {
                width: group.width,
                height: group.height,
                stageId: groupStageId,
                findings: findingsForStage(findings, groupStageId),
                showOwnFindings: !matchedStageIds.has(groupStageId),
                onSelect: () => onSelectStage?.(groupStageId),
              },
            };
          });
        })()
      : [];

    // Weighted exchange edges scale relative to the heaviest exchange on screen,
    // so thickness reads as "which shuffle moved the most data" rather than an
    // absolute byte count. Unweighted edges (plain parent-child links, broadcast
    // exchanges) fall through to the default edge renderer.
    const renderedEdges = visibleEdges ?? model.edges;
    const maxShuffleBytes = renderedEdges.reduce((max, e) => Math.max(max, e.shuffleBytes ?? 0), 0);
    const flowEdges: Edge[] = renderedEdges.map((e) =>
      e.shuffleBytes
        ? { id: e.id, source: e.source, target: e.target, type: 'exchange', data: { shuffleBytes: e.shuffleBytes, maxShuffleBytes } }
        : { id: e.id, source: e.source, target: e.target },
    );

    // Render order = paint order: stage boxes back, then segment boxes, then plan
    // nodes (React Flow renders last on top).
    return { flowNodes: [...stageGroupNodes, ...groupNodes, ...planNodes], flowEdges };
  }, [model, findings, stageId, segmentStageIds, visibleNodeIds, visibleEdges, onSelectStage]);

  const { ref: containerRef, tick: resizeTick } = useResizeTick();
  // Open by default: the nodes are glyph-only and the heat bar is color-coded,
  // so a first-time reader needs the key on screen rather than hidden behind a
  // toggle. The rail button still closes it once the vocabulary is learned.
  const [legendOpen, setLegendOpen] = useState(true);
  // `showMiniMap` gates whether the minimap is available at all; `miniMapOpen`
  // is the rail toggle on top of it. Both must hold for the minimap to render.
  const [miniMapOpen, setMiniMapOpen] = useState(true);

  const selectedNode = selectedNodeId
    ? flowNodes.find((n) => n.id === selectedNodeId && n.type === 'planNode')
    : undefined;

  const planNodes = flowNodes.filter((n) => n.type === 'planNode');
  // Biggest recoverable-time win first: cycle problem stages by descending
  // summed wall-clock (stages with no time claim sink to the end), so "Next
  // problem" points at the largest time saving.
  const problemNodes = flowNodes
    .filter((n) => n.type === 'stageGroup' && ((n.data as { findings?: Finding[] }).findings?.length ?? 0) > 0)
    .sort(byImpactDesc((n) => (n.data as { findings?: Finding[] }).findings ?? []));

  // The category filter can hide every operator in view (e.g. an I/O-only
  // filter over a segment with no scan/exchange). The canvas would then show
  // only the empty group boxes with no hint why; this surfaces the reason.
  const allNodesFiltered = visibleNodeIds != null && visibleNodeIds.size === 0 && model.nodes.length > 0;

  // Keyboard open for the node inspector. xyflow makes each node focusable and
  // selects it on Enter/Space in its own store, but never calls our
  // onNodeClick, so the docked inspector (the only fully-legible view of a
  // node) would be pointer-only. This bridges a focused plan node's Enter/Space
  // to the same onSelectNode the click path uses. Scoped to planNode wrappers,
  // so the decorative group boxes (now non-focusable anyway) can't trigger it.
  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node-planNode');
    const id = nodeEl?.getAttribute('data-id');
    if (!id) return;
    e.preventDefault();
    onSelectNode?.(id);
  };

  return (
    <ReactFlowProvider>
      {/* One tooltip provider for the whole canvas. Node finding badges and
          weighted-edge labels used to each mount their own base-ui
          Tooltip.Provider, which multiplied by node/edge count and added
          measurable render cost on a large plan; a single shared provider here
          serves every trigger below. */}
      <TooltipProvider>
      {/* The resize observer lives on this outer row, not the canvas wrapper
          below: opening the docked inspector shrinks the canvas wrapper (a flex
          sibling) but leaves this row's width unchanged, so a genuine layout
          resize (docs panel, window) still triggers a re-fit while opening a
          node no longer resets the user's pan/zoom. */}
      <div ref={containerRef} className="flex min-h-0 flex-1">
        <PlanGraphControlRail
          planNodes={planNodes}
          problemNodes={problemNodes}
          filterMode={filterMode}
          onFilterModeChange={onFilterModeChange}
          hiddenCount={hiddenCount}
          durationMode={durationMode}
          onDurationModeChange={onDurationModeChange}
          legendOpen={legendOpen}
          onToggleLegend={() => setLegendOpen((o) => !o)}
          miniMapOpen={showMiniMap && miniMapOpen}
          onToggleMiniMap={() => setMiniMapOpen((o) => !o)}
        />
        <div className="relative min-w-0 flex-1" onKeyDown={onCanvasKeyDown}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            aria-label="Plan graph. Operators and the data flowing between them. Tab to move between operators, Enter to open an operator's details."
            fitView
            fitViewOptions={FIT_OPTIONS}
            // Default minZoom (0.5) caps both the zoom-out button and the scroll
            // wheel well before a large full plan fits on screen; drop the floor
            // so a big graph can be zoomed all the way out to an overview.
            minZoom={0.05}
            edgesFocusable={false}
            onNodeClick={(_, node) => { if (node.type === 'planNode') onSelectNode?.(node.id); }}
            onPaneClick={() => onSelectNode?.(null)}
          >
            <Background />
            <ViewportAutoFit resizeTick={resizeTick} fitSignal={fitSignal} centerRequest={centerRequest} />
            {allNodesFiltered ? (
              <Panel position="top-center">
                <p role="status" className="rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground shadow-sm">
                  All {model.nodes.length} operators are hidden by the node filter. Change it in Settings to show them.
                </p>
              </Panel>
            ) : null}
            {legendOpen ? (
              <Panel position="bottom-left">
                <PlanGraphLegend />
              </Panel>
            ) : null}
            {showMiniMap && miniMapOpen ? (
              <MiniMap
                nodeColor={planGraphMiniMapNodeColor}
                pannable
                zoomable
                ariaLabel="Plan overview. Drag to pan and scroll to zoom the graph."
              />
            ) : null}
          </ReactFlow>
        </div>
        {selectedNode ? (
          <PlanGraphNodeDetail node={flowData(selectedNode)} onClose={() => onSelectNode?.(null)} onJumpToPaired={onJumpToPaired} />
        ) : null}
      </div>
      </TooltipProvider>
    </ReactFlowProvider>
  );
}
