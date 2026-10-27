import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ReactFlow, MiniMap, Background, Panel, useReactFlow, useNodesInitialized, useStore, ReactFlowProvider, Position, type Node, type Edge } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useLayoutPrewarm } from './useLayoutPrewarm';
import { LayoutProgress } from './LayoutProgress';
import { layoutWithDagre, computeGroupBoundsWithFallback, NODE_WIDTH, NODE_HEIGHT, STAGE_GROUP_PADDING_X, STAGE_GROUP_PADDING_Y, STAGE_GROUP_PADDING_BOTTOM, STAGE_GROUP_HEADER_HEIGHT, type PlanLayoutDirection } from './dagre-layout';
import { boundsOf, viewportShowsAll, FIT_TO_VIEW_OPTIONS, type Rect } from './readable-fit';
import { useReadableFit } from './useReadableFit';
import { PlanGraphNode } from './PlanGraphNode';
import { PlanGraphNodeDetail } from './PlanGraphNodeDetail';
import { useNarrowViewport } from './useNarrowViewport';
import { PlanGraphLegend } from './PlanGraphLegend';
import { PlanGraphControlRail } from './PlanGraphControlRail';
import { planGraphMiniMapNodeColor } from './plan-graph-minimap';
import { PlanGraphSegmentGroupNode } from './PlanGraphSegmentGroupNode';
import { PlanGraphStageGroupNode, PlanGraphUnmatchedStageNode } from './PlanGraphStageGroupNode';
import { PlanGraphExchangeEdge } from './PlanGraphExchangeEdge';
import { formatDuration } from '@sparkforensics/core/format-utils.ts';
import { findingStageIds } from '@sparkforensics/core/findings-of-type.ts';
import { TooltipProvider } from '@/components/ui/tooltip';
import { orderByImpact } from '@/view/impact-sort';
import { useInterpretation } from '@/view/interpretation';
import type { Finding, PlanGraphDurationMode, PlanGraphEdge, PlanGraphFilterMode, PlanGraphModel, PlanGraphNodeData, StageId } from '@sparkforensics/core/types.ts';

const nodeTypes = {
  planNode: PlanGraphNode,
  segmentGroup: PlanGraphSegmentGroupNode,
  stageGroup: PlanGraphStageGroupNode,
  unmatchedStage: PlanGraphUnmatchedStageNode,
};

const edgeTypes = {
  exchange: PlanGraphExchangeEdge,
};

// Stand-ins while the first large layout is still being computed.
const NO_FLOW_NODES: Node[] = [];
const NO_FLOW_EDGES: Edge[] = [];

// Paint order, all above React Flow's edge layer (z 0): segment fills, then the
// stage box with its header, then plan nodes. Boxes above the edges keep a routed
// edge from painting over their finding chips; the translucent fills let it read
// through.
const SEGMENT_GROUP_Z = 1;
const STAGE_GROUP_Z = 2;
const PLAN_NODE_Z = 3;

// Room above the graph for an unmatched focal stage's header row and its note,
// and the gap between them and the graph.
const UNMATCHED_STAGE_HEADER_HEIGHT = 40;
const UNMATCHED_STAGE_HEADER_GAP = 8;

// Node<T> requires T extends Record<string, unknown>, which PlanGraphNodeData (a
// closed interface) doesn't satisfy; read data through this cast so `nodes` stays
// the plain Node[] that <ReactFlow nodes={...}> expects.
type PlanGraphFlowNodeData = PlanGraphNodeData & { durationSharePct: number | null };
const flowData = (n: Node) => n.data as unknown as PlanGraphFlowNodeData;

/** A recenter request from a paired-node jump. `token` monotonically increments
 * per request so a repeat jump to the same node still fires the effect; token 0
 * is the initial no-op. */
export type CenterRequest = { nodeId: string | null; token: number };

const nodeMiddle = (node: Node) => ({
  x: node.position.x + (node.measured?.width ?? NODE_WIDTH) / 2,
  y: node.position.y + (node.measured?.height ?? NODE_HEIGHT) / 2,
});

// Automatic re-fits clamp to a readable zoom; the first fit and the rail's "Fit
// to view" are the full overview with no floor (see readable-fit.ts).
function ViewportAutoFit({ resizeTick, fitSignal, centerRequest, sheetNodeId }: { resizeTick: number; fitSignal: number; centerRequest?: CenterRequest; sheetNodeId: string | null }) {
  const { fitView, setCenter, getNode, getZoom } = useReactFlow();
  const fitReadable = useReadableFit();
  const nodesInitialized = useNodesInitialized();
  const canvasWidth = useStore((s) => s.width);
  const canvasHeight = useStore((s) => s.height);
  const didInitialFit = useRef(false);

  // First fit: waits for the canvas to have a size and the nodes to be measured.
  useEffect(() => {
    if (didInitialFit.current || !nodesInitialized || !canvasWidth || !canvasHeight) return;
    didInitialFit.current = true;
    void fitView(FIT_TO_VIEW_OPTIONS);
  }, [nodesInitialized, canvasWidth, canvasHeight, fitView]);

  // On a phone the node detail is a bottom sheet that shrinks the canvas, so
  // the selected node can end up under it or off-screen. Pan it to the middle
  // of the canvas that remains, keeping the user's zoom. Re-runs when the pane
  // height settles after the sheet opens; `sheetNodeId` is null on desktop and
  // while nothing is selected.
  useEffect(() => {
    if (!sheetNodeId) return;
    const target = getNode(sheetNodeId);
    if (!target) return;
    const { x, y } = nodeMiddle(target);
    setCenter(x, y, { zoom: getZoom(), duration: 200 });
  }, [sheetNodeId, canvasHeight, getNode, setCenter, getZoom]);

  // Recenter on a paired-node jump. Token 0 is the initial value, so the mount
  // never pans. Falls back to a by-id fitView when the node isn't in the store
  // yet (the tick right after a scope expand brought the partner into view).
  useEffect(() => {
    if (!centerRequest || centerRequest.token === 0 || !centerRequest.nodeId) return;
    const target = getNode(centerRequest.nodeId);
    if (target) {
      const { x, y } = nodeMiddle(target);
      setCenter(x, y, { zoom: 1, duration: 300 });
    } else fitView({ nodes: [{ id: centerRequest.nodeId }], duration: 300, maxZoom: 1 });
  }, [centerRequest, setCenter, getNode, fitView]);

  useEffect(() => {
    const onResize = () => fitReadable(200);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [fitReadable]);

  // The docs panel resizes this container via CSS, not the window, so `resize`
  // never fires for it; resizeTick covers that. tick 0 is the initial
  // measurement, already handled by the initial fit.
  useEffect(() => {
    if (resizeTick === 0) return;
    fitReadable(200);
  }, [resizeTick, fitReadable]);

  // Re-fit on a scope flip: the new graph is a very different size. Signal 0 is
  // the initial value, already covered by the initial fit.
  useEffect(() => {
    if (fitSignal === 0) return;
    fitReadable(300);
  }, [fitSignal, fitReadable]);

  return null;
}

/** Reports whether part of the graph is off screen at the current viewport. */
function OverflowReporter({ bounds, onChange }: { bounds: Rect | null; onChange: (overflows: boolean) => void }) {
  const overflows = useStore((s) => {
    if (!bounds || !s.width || !s.height) return true;
    const [x, y, zoom] = s.transform;
    return !viewportShowsAll(bounds, { x, y, zoom }, { width: s.width, height: s.height });
  });
  useEffect(() => onChange(overflows), [overflows, onChange]);
  return null;
}

// Past this many plan nodes a phone-width plan overflows the canvas either way,
// so the second dagre pass that stacks it is not worth its cost.
const STACK_MAX_NODES = 150;

/** Fires on every container resize after the first (initial) measurement. */
function useResizeTick() {
  const [el, ref] = useState<HTMLDivElement | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
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
  }, [el]);
  return { ref, tick };
}

const NO_FINDINGS: Finding[] = [];

function findingsForStage(findings: Finding[], stageId: StageId): Finding[] {
  return findings.filter((finding) => finding.stageId === stageId || findingStageIds(finding)?.includes(stageId));
}

export function PlanGraphCanvas({
  model, showMiniMap, findings = NO_FINDINGS, stageId, segmentStageIds, visibleNodeIds, visibleEdges, onSelectStage,
  selectedNodeId = null, onSelectNode,
  stagePanel,
  onJumpToPaired,
  centerRequest,
  fitSignal = 0,
  filterMode = 'basic', onFilterModeChange = () => {}, hiddenCount = 0, emptyFilterModes,
  durationMode = 'exclusive', onDurationModeChange = () => {},
  showInfo = false, onShowInfoChange = () => {}, infoNoteCount = 0,
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
  /** A stage's findings panel. It fills the inspector slot the node detail
   * uses, which the route keeps exclusive: a selected node replaces it. */
  stagePanel?: ReactNode;
  /** Selects and recenters the paired half of a split Exchange node, from the
   * detail card. The route owns the cross-scope expand this may require. */
  onJumpToPaired?: (pairedNodeId: string) => void;
  /** A paired-node jump's recenter request; the route bumps its token per jump. */
  centerRequest?: CenterRequest;
  /** Incremented by the route on an Expand/Back scope switch to trigger a
   * fit-to-view; 0 is the initial value (no fit beyond the mount-time one). */
  fitSignal?: number;
  /** Node filter + duration settings, surfaced from the control rail's Settings
   * popover. The route owns the state. */
  filterMode?: PlanGraphFilterMode;
  onFilterModeChange?: (mode: PlanGraphFilterMode) => void;
  hiddenCount?: number;
  emptyFilterModes?: ReadonlySet<PlanGraphFilterMode>;
  durationMode?: PlanGraphDurationMode;
  onDurationModeChange?: (mode: PlanGraphDurationMode) => void;
  showInfo?: boolean;
  onShowInfoChange?: (show: boolean) => void;
  infoNoteCount?: number;
}) {
  const { ref: containerRef, tick: resizeTick } = useResizeTick();
  const narrow = useNarrowViewport();
  const interpretation = useInterpretation();
  // Everything the layout depends on, apart from the node data. Kept separate so
  // the large layouts can be computed in a worker (useLayoutPrewarm) before the
  // memo below, which then finds them in the layout cache.
  const layoutPlan = useMemo(() => {
    const groupOf = (n: PlanGraphNodeData) => `segment-${n.segmentIndex}`;
    // A segment with no stage pair of its own (inherited) is not inside a stage
    // box: its stage id is only the nearest one.
    const pairedStageOf = (segmentIndex: number) => (model.inheritedSegments.has(segmentIndex) ? undefined : segmentStageIds?.get(segmentIndex));
    const stageGroupOf = (n: PlanGraphNodeData) => {
      const sId = pairedStageOf(n.segmentIndex);
      return sId != null ? `stage-${sId}` : null;
    };

    // Foreground nodes/edges laid out on their own compact subgraph so filtering
    // closes gaps instead of stranding visible nodes. With no filter this is the
    // whole model, so it doubles as the fallback layout below (single pass).
    const layoutNodes = visibleNodeIds ? model.nodes.filter((n) => visibleNodeIds.has(n.id)) : model.nodes;
    const layoutEdges = visibleNodeIds ? visibleEdges ?? model.edges : model.edges;
    // Desktop keeps one right-to-left flow at every size (ancestors always to
    // the right, in reading order): a long chain scrolls sideways at the
    // readable zoom. Only a phone-width canvas stacks the plan bottom-to-top, so
    // it scrolls down instead.
    const direction: PlanLayoutDirection = narrow && layoutNodes.length <= STACK_MAX_NODES ? 'BT' : 'RL';
    // A fully-filtered segment/stage (every member hidden) still gets a box,
    // positioned from a full-model layout fallback. That compound Dagre pass
    // over every node is the most expensive layout the canvas does (roughly the
    // visible pass again, but over the larger unfiltered set), so run it only
    // when a group is genuinely missing from the visible layout. In a normal
    // full open each Exchange-bounded segment keeps its exchange node under the
    // basic filter, so nothing is missing and this pass is skipped entirely.
    const coveredSegments = new Set(layoutNodes.map(groupOf));
    const coveredStages = new Set(layoutNodes.map(stageGroupOf).filter((id): id is string => id != null));
    const needsFullFallback =
      model.nodes.some((n) => !coveredSegments.has(groupOf(n))) ||
      model.nodes.some((n) => {
        const id = stageGroupOf(n);
        return id != null && !coveredStages.has(id);
      });
    return { groupOf, pairedStageOf, stageGroupOf, layoutNodes, layoutEdges, direction, needsFullFallback };
  }, [model, segmentStageIds, visibleNodeIds, visibleEdges, narrow]);

  const layoutRequests = useMemo(() => {
    const { groupOf, layoutNodes, layoutEdges, direction, needsFullFallback } = layoutPlan;
    const requests = [{ nodes: layoutNodes, edges: layoutEdges, groupOf, direction }];
    if (needsFullFallback) requests.push({ nodes: model.nodes, edges: model.edges, groupOf, direction });
    return requests;
  }, [layoutPlan, model]);
  const layoutReady = useLayoutPrewarm(layoutRequests);

  const built = useMemo(() => {
    // A large layout still running in the worker: nothing to build yet.
    if (!layoutReady) return null;
    const { groupOf, pairedStageOf, stageGroupOf, layoutNodes, layoutEdges, direction, needsFullFallback } = layoutPlan;
    // Sums the exclusive share, not the mode-selected one, so the total does not
    // grow with tree depth in inclusive mode (docs-site/contributor-guide/
    // architecture/drill-down/plan-graph.md, "Duration share"). Falls back to `durationShare` for hand-built
    // fixtures that don't set the exclusive field.
    const totalDuration = model.nodes.reduce((sum, n) => sum + (n.exclusiveDurationShare ?? n.durationShare ?? 0), 0);
    const laidOutVisible = layoutWithDagre(layoutNodes, layoutEdges, { groupOf, direction });
    const laidOutFull = needsFullFallback
      ? layoutWithDagre(model.nodes, model.edges, { groupOf, direction })
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
        ...(direction === 'BT' ? { sourcePosition: Position.Top, targetPosition: Position.Bottom } : {}),
      };
    });

    // A paired segment is the inside of its stage box and paints nothing itself.
    // A segment with no pair of its own gets a dashed box of its own, so no stage
    // box has to reach across it.
    const unpairedGroupOf = (n: PlanGraphNodeData) => (pairedStageOf(n.segmentIndex) == null ? groupOf(n) : null);

    // Group boxes are plain background nodes in the members' coordinate space
    // (not xyflow parent/child nesting). Bounds come from the compact layout when
    // a segment still has a visible member, else from the full-model layout.
    const groupNodes: Node[] = computeGroupBoundsWithFallback(unpairedGroupOf, [laidOutVisible, laidOutFull]).map((group) => {
      const segmentIndex = Number(group.id.replace('segment-', ''));
      // Totals cover the segment's unfiltered content, so read model.nodes, not a
      // laid-out set (laidOutFull aliases the filtered one when the fallback is skipped).
      const membersInGroup = model.nodes.filter((n) => groupOf(n) === group.id);
      // Exclusive shares, as in `totalDuration` above.
      const groupDuration = membersInGroup.reduce((sum, n) => sum + (n.exclusiveDurationShare ?? n.durationShare ?? 0), 0);
      const hasAnyDuration = membersInGroup.some((n) => n.durationShare != null);
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
          nearestStageId: segmentStageIds?.get(segmentIndex) ?? null,
          durationLabel: hasAnyDuration ? formatDuration(groupDuration) : null,
        },
      };
    });

    // One stroked box per stage wrapping its paired segment, and the only place
    // the stage's name, duration and findings are painted. It wraps the paired
    // segment's plan nodes directly, with room above them for the header.
    const groupOptions = {
      paddingX: STAGE_GROUP_PADDING_X,
      paddingY: STAGE_GROUP_PADDING_Y,
      paddingBottom: STAGE_GROUP_PADDING_BOTTOM,
      headerHeight: STAGE_GROUP_HEADER_HEIGHT,
    };
    const stageGroups = computeGroupBoundsWithFallback(stageGroupOf, [laidOutVisible, laidOutFull], groupOptions);
    // A stage box can start inside another (a stage paired with segments on
    // both sides of another stage's). Each header sits at its box's top edge, so
    // painting boxes in top-edge order keeps every header above the overlays of
    // the boxes it starts inside.
    stageGroups.sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    const stageGroupNodes: Node[] = stageGroups.map((group) => {
      const groupStageId = Number(group.id.replace('stage-', ''));
      return {
        id: group.id,
        type: 'stageGroup',
        position: group.position,
        draggable: false,
        selectable: false,
        // Decorative wrapper; its inner "Focus stage N" button is the control.
        focusable: false,
        zIndex: STAGE_GROUP_Z,
        style: { width: group.width, height: group.height },
        measured: { width: group.width, height: group.height },
        data: {
          width: group.width,
          height: group.height,
          stageId: groupStageId,
          findings: findingsForStage(findings, groupStageId),
          durationLabel: model.stageDurations.has(groupStageId) ? formatDuration(model.stageDurations.get(groupStageId)!) : null,
          // Only the full plan has other stages to focus.
          onSelect: model.scope === 'full' && onSelectStage ? () => onSelectStage(groupStageId) : undefined,
        },
      };
    });

    // Exchange edge thickness is relative to the heaviest exchange on screen.
    // Unweighted edges fall through to the default renderer.
    const renderedEdges = visibleEdges ?? model.edges;
    const maxShuffleBytes = renderedEdges.reduce((max, e) => Math.max(max, e.shuffleBytes ?? 0), 0);
    const flowEdges: Edge[] = renderedEdges.map((e) =>
      e.shuffleBytes
        ? { id: e.id, source: e.source, target: e.target, type: 'exchange', data: { shuffleBytes: e.shuffleBytes, maxShuffleBytes } }
        : { id: e.id, source: e.source, target: e.target },
    );

    // Within one z index, render order = paint order (React Flow renders last on top).
    const flowNodes = [...stageGroupNodes, ...groupNodes, ...planNodes];
    const rectOf = (n: Node) => ({ x: n.position.x, y: n.position.y, width: n.measured?.width ?? 0, height: n.measured?.height ?? 0 });
    // Zipping can leave the focal stage unpaired (its segment loses the
    // Math.min(segments, stages) slot). Its findings stay reachable from a
    // header above the graph, which encloses no node.
    const focalFindings = findingsForStage(findings, stageId);
    const contentBounds = boundsOf(flowNodes.map(rectOf));
    if (focalFindings.length > 0 && contentBounds && !stageGroups.some((group) => group.id === `stage-${stageId}`)) {
      const width = contentBounds.width;
      const height = UNMATCHED_STAGE_HEADER_HEIGHT;
      flowNodes.unshift({
        id: `stage-${stageId}`,
        type: 'unmatchedStage',
        position: { x: contentBounds.x, y: contentBounds.y - UNMATCHED_STAGE_HEADER_GAP - height },
        draggable: false,
        selectable: false,
        focusable: false,
        zIndex: STAGE_GROUP_Z,
        style: { width, height },
        measured: { width, height },
        data: {
          width,
          height,
          stageId,
          findings: focalFindings,
          durationLabel: model.stageDurations.has(stageId) ? formatDuration(model.stageDurations.get(stageId)!) : null,
        },
      });
    }
    const graphBounds = boundsOf(flowNodes.map(rectOf));
    return { flowNodes, flowEdges, graphBounds };
  }, [model, findings, stageId, segmentStageIds, visibleEdges, onSelectStage, layoutPlan, layoutReady]);

  // While a new large layout is computed the previous graph stays on screen (the
  // first open has none, so it shows the loading line instead).
  const lastBuilt = useRef(built);
  useEffect(() => {
    if (built) lastBuilt.current = built;
  }, [built]);
  const shown = built ?? lastBuilt.current;
  const layingOut = built == null;
  const flowNodes = shown?.flowNodes ?? NO_FLOW_NODES;
  const flowEdges = shown?.flowEdges ?? NO_FLOW_EDGES;
  const graphBounds = shown?.graphBounds ?? null;

  // Collapsed by default: the key is about 450x190 px and would cover a corner.
  const [legendOpen, setLegendOpen] = useState(false);
  // `showMiniMap` gates availability; within it the minimap follows overflow until
  // the rail toggle forces it (`miniMapChoice`, null until then).
  const [graphOverflows, setGraphOverflows] = useState(true);
  const [miniMapChoice, setMiniMapChoice] = useState<boolean | null>(null);
  const miniMapOpen = showMiniMap && (miniMapChoice ?? graphOverflows);

  const selectedNode = selectedNodeId
    ? flowNodes.find((n) => n.id === selectedNodeId && n.type === 'planNode')
    : undefined;

  // The legend and minimap float over the canvas and would cover the node the
  // sheet just centered (or the graph itself, for a stage panel), so they stay
  // hidden while a sheet is up.
  const sheetOpen = narrow && (selectedNode != null || stagePanel != null);

  const planNodes = flowNodes.filter((n) => n.type === 'planNode');
  // Verdict order, so "Next problem" starts at the first step the verdict names.
  // Only the full-plan view has stages to step between.
  const problemNodes = orderByImpact(
    interpretation,
    flowNodes.filter((n) => model.scope === 'full' && (n.type === 'stageGroup' || n.type === 'unmatchedStage') && ((n.data as { findings?: Finding[] }).findings?.length ?? 0) > 0),
    (n) => (n.data as { findings?: Finding[] }).findings ?? [],
  );

  // xyflow selects a focused node on Enter/Space in its own store but never calls
  // onNodeClick, so this bridges the key to onSelectNode. Scoped to planNode
  // wrappers so the decorative group boxes can't trigger it.
  const onCanvasKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const nodeEl = (e.target as HTMLElement).closest('.react-flow__node-planNode');
    const id = nodeEl?.getAttribute('data-id');
    if (!id) return;
    e.preventDefault();
    onSelectNode?.(id);
  };

  if (!shown) {
    return <LayoutProgress />;
  }

  return (
    <ReactFlowProvider>
      {/* One shared tooltip provider: a provider per badge or edge label adds
          measurable render cost on a large plan. */}
      <TooltipProvider>
      {/* The resize observer sits on this outer row, not the canvas wrapper, so
          opening the docked inspector (which shrinks only the wrapper) does not
          re-fit and reset the user's pan/zoom. */}
      <div ref={containerRef} className="flex min-h-0 flex-1 flex-col sm:flex-row">
        {/* Rail and canvas share a row so that on a phone the node detail can
            sit below them as a bottom sheet instead of beside them. */}
        <div className="flex min-h-0 min-w-0 flex-1">
        <PlanGraphControlRail
          planNodes={planNodes}
          problemNodes={problemNodes}
          filterMode={filterMode}
          onFilterModeChange={onFilterModeChange}
          hiddenCount={hiddenCount}
          emptyFilterModes={emptyFilterModes}
          durationMode={durationMode}
          onDurationModeChange={onDurationModeChange}
          showInfo={showInfo}
          onShowInfoChange={onShowInfoChange}
          infoNoteCount={infoNoteCount}
          legendOpen={legendOpen}
          onToggleLegend={() => setLegendOpen((o) => !o)}
          miniMapOpen={miniMapOpen}
          onToggleMiniMap={() => setMiniMapChoice(!miniMapOpen)}
        />
        <div className="relative min-w-0 flex-1" onKeyDown={onCanvasKeyDown}>
          <ReactFlow
            nodes={flowNodes}
            edges={flowEdges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            aria-label="Plan graph. Operators and the data flowing between them. Tab to move between operators, Enter to open an operator's details."
            // Default minZoom (0.5) caps both the zoom-out button and the scroll
            // wheel well before a large full plan fits on screen; drop the floor
            // so a big graph can be zoomed all the way out to an overview.
            minZoom={0.05}
            edgesFocusable={false}
            onNodeClick={(_, node) => { if (node.type === 'planNode') onSelectNode?.(node.id); }}
            onPaneClick={() => onSelectNode?.(null)}
          >
            <Background />
            <ViewportAutoFit resizeTick={resizeTick} fitSignal={fitSignal} centerRequest={centerRequest} sheetNodeId={narrow ? selectedNode?.id ?? null : null} />
            {layingOut ? (
              <Panel position="top-center">
                <LayoutProgress compact />
              </Panel>
            ) : null}
            {legendOpen && !sheetOpen ? (
              <Panel position="bottom-left">
                <PlanGraphLegend />
              </Panel>
            ) : null}
            <OverflowReporter bounds={graphBounds} onChange={setGraphOverflows} />
            {miniMapOpen && !sheetOpen ? (
              <MiniMap
                nodeColor={planGraphMiniMapNodeColor}
                pannable
                zoomable
                ariaLabel="Plan overview. Drag to pan and scroll to zoom the graph."
              />
            ) : null}
          </ReactFlow>
        </div>
        </div>
        {selectedNode ? (
          <PlanGraphNodeDetail node={flowData(selectedNode)} sheet={narrow} onClose={() => onSelectNode?.(null)} onJumpToPaired={onJumpToPaired} />
        ) : stagePanel}
      </div>
      </TooltipProvider>
    </ReactFlowProvider>
  );
}
