import { useCallback, useEffect, useId, useMemo, useReducer, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { resolvePlanTree } from '@/view/plan-tree';
import { buildPlanGraphModel } from '@sparkforensics/core/plan-graph-model.ts';
import { PlanGraphCanvas, type CenterRequest } from '@/view/plan-graph/PlanGraphCanvas';
import { PlanGraphStageDetail } from '@/view/plan-graph/PlanGraphStageDetail';
import { StageSelectionProvider, type StageSelection } from '@/view/plan-graph/stage-selection';
import { warmLayoutWorker } from '@/view/plan-graph/layout-worker-client';
import { ExpandConfirmDialog } from '@/view/plan-graph/ExpandConfirmDialog';
import { Topbar } from '@/view/Topbar';
import { DocsLink } from '@/view/DocsContext';
import { useStageDetail } from '@/view/StageDetailContext';
import { StageDetailDialog } from '@/view/widgets/StageDetailDialog';
import { useIngest } from '@/store/useIngest';
import { useRecentFiles } from '@/view/useRecentFiles';
import { emptySelection, filterFindings } from '@/view/finding-filter';
import type { AppModel, Finding, PlanGraphDurationMode, PlanGraphEdge, PlanGraphFilterMode, PlanGraphModel, StageId } from '@sparkforensics/core/types.ts';

export interface PlanGraphRouteProps {
  stageId: StageId;
  appModel: AppModel;
  findings: Finding[];
  activeFileId: string | null;
  onClose: () => void;
  initialScope?: 'segment' | 'full';
}

const CATEGORY_BY_MODE: Record<PlanGraphFilterMode, string[] | null> = {
  io: ['scan', 'exchange'],
  basic: ['scan', 'exchange', 'join', 'aggregate', 'sort', 'filter'],
  advanced: null, // null = no category filter, show everything
};

const MODES_NARROW_TO_WIDE: PlanGraphFilterMode[] = ['io', 'basic', 'advanced'];

const EXPAND_GUARDRAIL_THRESHOLD = 300;

/** Exposed for tests: the category filter (`io`/`basic`) hides whole
 * categories of nodes, including pass-through operators (e.g. Project)
 * that sit between two otherwise-visible nodes. A plain "keep the edge only
 * if both endpoints are visible" filter drops those edges instead of
 * reconnecting around the hidden node, fragmenting one connected plan into
 * several disconnected pieces. This walks forward through chains of hidden
 * nodes and rewires each visible node directly to its nearest visible
 * descendant(s), so hiding a category never changes connectivity between
 * the nodes that remain on screen. */
export function collapseHiddenEdges(edges: PlanGraphEdge[], visibleNodeIds: Set<string>): PlanGraphEdge[] {
  const targetsBySource = new Map<string, string[]>();
  for (const e of edges) {
    const targets = targetsBySource.get(e.source);
    if (targets) targets.push(e.target);
    else targetsBySource.set(e.source, [e.target]);
  }

  // Memoized per node id: `resolveVisibleTargets` is only ever called with
  // a hidden node's own id when recursing, and the plan tree (plus the
  // Exchange read/write split) never introduces a cycle back to an
  // ancestor, so a plain memo (no separate in-progress guard) is safe.
  const memo = new Map<string, Set<string>>();
  function resolveVisibleTargets(nodeId: string): Set<string> {
    const cached = memo.get(nodeId);
    if (cached) return cached;
    const resolved = new Set<string>();
    memo.set(nodeId, resolved);
    for (const target of targetsBySource.get(nodeId) ?? []) {
      if (visibleNodeIds.has(target)) resolved.add(target);
      else for (const t of resolveVisibleTargets(target)) resolved.add(t);
    }
    return resolved;
  }

  // Carry an exchange edge's shuffle weight across the rewrite, but only for a
  // direct visible->visible edge that existed in the input. A collapsed edge
  // synthesized across a chain of hidden nodes represents no single original
  // exchange, so it stays unweighted. In a tree there is one path between any
  // two nodes, so a synthetic pair can never collide with a real weighted one.
  const shuffleByEdge = new Map<string, number>();
  for (const e of edges) {
    if (e.shuffleBytes) shuffleByEdge.set(`${e.source}->${e.target}`, e.shuffleBytes);
  }

  const collapsed: PlanGraphEdge[] = [];
  for (const sourceId of visibleNodeIds) {
    for (const targetId of resolveVisibleTargets(sourceId)) {
      const edge: PlanGraphEdge = { id: `${sourceId}=>${targetId}`, source: sourceId, target: targetId };
      const shuffleBytes = shuffleByEdge.get(`${sourceId}->${targetId}`);
      if (shuffleBytes) edge.shuffleBytes = shuffleBytes;
      collapsed.push(edge);
    }
  }
  return collapsed;
}

function safeBuildPlanGraphModel(
  planTree: NonNullable<ReturnType<typeof resolvePlanTree>>,
  opts: { scope: 'segment' | 'full'; stageId: StageId; appModel: AppModel; findings: Finding[]; durationMode: PlanGraphDurationMode },
): PlanGraphModel | null {
  try {
    return buildPlanGraphModel(planTree, opts) as PlanGraphModel;
  } catch {
    return null;
  }
}

// Memo per run model: rebuilding the model on every re-render or re-open is wasted work. A run is
// a new AppModel, so its entries never outlive it and a reload of the same file starts empty.
// Keyed on (stageId, scope, durationMode, showInfo) within a run, not stageId alone
// (docs-site/contributor-guide/architecture/drill-down/plan-graph.md).
type CacheKey = string;
let planGraphModelCache = new WeakMap<AppModel, Map<CacheKey, PlanGraphModel>>();

function cacheKey(stageId: StageId, scope: 'segment' | 'full', durationMode: PlanGraphDurationMode, showInfo: boolean): CacheKey {
  return `${stageId}::${scope}::${durationMode}::${showInfo}`;
}

/** Exposed for tests: clears every memoized model, e.g. between test cases
 * so a stale entry from one test can't leak into the next. */
export function clearPlanGraphModelCache(): void {
  planGraphModelCache = new WeakMap();
}

/** Exposed for tests. */
export function memoizedBuildPlanGraphModel(
  planTree: NonNullable<ReturnType<typeof resolvePlanTree>>,
  opts: { scope: 'segment' | 'full'; stageId: StageId; appModel: AppModel; findings: Finding[]; durationMode: PlanGraphDurationMode },
  showInfo: boolean,
): PlanGraphModel | null {
  let models = planGraphModelCache.get(opts.appModel);
  if (!models) {
    models = new Map();
    planGraphModelCache.set(opts.appModel, models);
  }
  const key = cacheKey(opts.stageId, opts.scope, opts.durationMode, showInfo);
  const cached = models.get(key);
  if (cached) return cached;
  const result = safeBuildPlanGraphModel(planTree, opts);
  if (result) models.set(key, result);
  return result;
}

/** What the route's view is showing and what is picked in it. One reducer owns them, so an action that
 * changes the view also decides the selection and the jump target that go with it. */
export interface PlanView {
  focusStageId: StageId;
  requestedScope: 'segment' | 'full';
  /** Id of the plan node whose detail card is open (null = none), held here so the single Escape
   * handler can close it before the route. */
  selectedNodeId: string | null;
  /** Recenter request for a paired-node jump; separate from the fit signal so a jump focuses the
   * partner rather than re-fitting the graph. */
  center: CenterRequest;
}

export type PlanViewAction =
  | { type: 'selectNode'; id: string | null }
  /** Jump to a node of the model on screen: select it and recenter on it. */
  | { type: 'jumpTo'; id: string }
  /** Switch scope. A node id only means something in one stage and scope, so the selection is
   * cleared, or is the jump target the switch was made for (the two Exchange halves always live in
   * different segments). */
  | { type: 'setScope'; scope: 'segment' | 'full'; jumpTo?: string }
  | { type: 'focusStage'; stageId: StageId };

export function planViewReducer(view: PlanView, action: PlanViewAction): PlanView {
  const centered = (id: string): CenterRequest => ({ nodeId: id, token: view.center.token + 1 });
  switch (action.type) {
    case 'selectNode':
      return { ...view, selectedNodeId: action.id };
    case 'jumpTo':
      return { ...view, selectedNodeId: action.id, center: centered(action.id) };
    case 'setScope':
      return { ...view, requestedScope: action.scope, selectedNodeId: action.jumpTo ?? null, center: action.jumpTo ? centered(action.jumpTo) : view.center };
    case 'focusStage':
      return { ...view, focusStageId: action.stageId, requestedScope: 'segment', selectedNodeId: null };
    default:
      return view;
  }
}

export function PlanGraphRoute({ stageId, appModel, findings: catalog, activeFileId, onClose, initialScope }: PlanGraphRouteProps) {
  const { resetToDropZone, getTaskData } = useIngest();
  const { openStage, close: closeStageDetail } = useStageDetail();
  const { recentEntries, onPickRecent, onRemoveRecent } = useRecentFiles(activeFileId);
  const [filterMode, setFilterMode] = useState<PlanGraphFilterMode>('basic');
  const [durationMode, setDurationMode] = useState<PlanGraphDurationMode>('exclusive');
  // Same default as the dashboard: info findings are notes, listed only on request.
  const [showInfo, setShowInfo] = useState(false);
  const findings = useMemo(() => (showInfo ? catalog : filterFindings(catalog, emptySelection())), [catalog, showInfo]);
  const infoNoteCount = useMemo(() => catalog.filter((f) => f.impactBand === 'info').length, [catalog]);
  // Which stage's plan segment is in view (seeded from the stageId prop on a remount, App.tsx's
  // key={stageId}), at which scope, and what is picked in it.
  const [view, dispatch] = useReducer(planViewReducer, {
    focusStageId: stageId,
    requestedScope: initialScope ?? 'segment',
    selectedNodeId: null,
    center: { nodeId: null, token: 0 },
  });
  const { focusStageId, requestedScope, center: centerRequest } = view;
  const [initialFullResolved, setInitialFullResolved] = useState(initialScope !== 'full');
  // The expand awaiting the reader's confirmation, with the paired node to jump to once it is
  // confirmed (null for a plain expand).
  const [expandRequest, setExpandRequest] = useState<{ jumpTo: string | null } | null>(null);
  // The view whose oversized fallback the reader dismissed: another stage, duration mode or info
  // setting is a different view with its own model.
  const [dismissedView, setDismissedView] = useState<string | null>(null);
  const fallbackView = `${focusStageId}::${durationMode}::${showInfo}`;
  // Id of the stage whose findings panel is open (null = none). It shares the
  // inspector slot with the node detail, so selecting one closes the other.
  const [stagePanelId, setStagePanelId] = useState<StageId | null>(null);
  // The chip or title that opened the panel, which gets focus back on close.
  const stageEntryRef = useRef<HTMLElement | null>(null);
  // Bumped on each scope switch; the canvas re-fits on each change.
  const [fitSignal, setFitSignal] = useState(0);

  const selectNode = useCallback((id: string | null) => {
    dispatch({ type: 'selectNode', id });
    if (id) setStagePanelId(null);
  }, []);
  const stageSelection = useMemo<StageSelection>(
    () => ({
      selectedStageId: stagePanelId,
      select: (id, entry) => {
        stageEntryRef.current = entry;
        setStagePanelId(id);
        dispatch({ type: 'selectNode', id: null });
      },
    }),
    [stagePanelId],
  );
  const panelStage = stagePanelId != null ? appModel.stages.get(stagePanelId) : undefined;

  // The stage detail dialog's open state sits above both routes, so a dialog
  // opened on the dashboard (its "View plan graph" button) is still open here.
  // Clear it first and mount the dialog after: one that opens and closes in the
  // same frame never finishes its exit transition and leaves its scrim behind.
  const [dialogMounted, setDialogMounted] = useState(false);
  useEffect(() => {
    closeStageDetail();
    setDialogMounted(true);
  }, [closeStageDetail]);

  const planTree = resolvePlanTree(focusStageId, appModel);

  const segmentModel = planTree
    ? memoizedBuildPlanGraphModel(planTree, { scope: 'segment', stageId: focusStageId, appModel, findings, durationMode }, showInfo)
    : null;

  // A 'segment' request can fall back to a 'full' model inside
  // buildPlanGraphModel; that must pass the same node-count guardrail as an
  // explicit expand. Deliberately independent of the dismissal: dismissing
  // the dialog must not lift the block on the oversized model.
  const segmentFellBackOversized =
    segmentModel != null &&
    segmentModel.scope === 'full' &&
    requestedScope === 'segment' &&
    segmentModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD;

  // Asks for confirmation unless the reader dismissed this view's fallback.
  const segmentFellBackUnguarded = segmentFellBackOversized && dismissedView !== fallbackView;
  const confirmExpandOpen = expandRequest != null || segmentFellBackUnguarded;

  const fullModel = planTree && (requestedScope === 'full' || confirmExpandOpen)
    ? memoizedBuildPlanGraphModel(planTree, { scope: 'full', stageId: focusStageId, appModel, findings, durationMode }, showInfo)
    : null;

  // `initialScope: 'full'` is not consent to render any size: the dialog opens on
  // the first render and the model is withheld until confirm/cancel.
  const initialFullOversized =
    !initialFullResolved &&
    requestedScope === 'full' &&
    fullModel != null &&
    fullModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD;
  const guardrailOpen = confirmExpandOpen || initialFullOversized;

  // The guardrail dialog means a large graph is about to be laid out; the user
  // reads it while the layout worker loads.
  useEffect(() => {
    if (guardrailOpen) warmLayoutWorker();
  }, [guardrailOpen]);

  const model = segmentFellBackOversized
    ? null // held back until an explicit confirm flips requestedScope to 'full'
    : initialFullOversized
      ? null
    : requestedScope === 'full'
      ? fullModel
      : segmentModel;

  // Modes that would show no node in this view. The chosen mode stays in state
  // (other stages still use it); the view widens to the next mode that shows
  // something.
  const emptyModes = useMemo(
    () => new Set(MODES_NARROW_TO_WIDE.filter((mode) => {
      const categories = CATEGORY_BY_MODE[mode];
      return categories != null && !model?.nodes.some((n) => categories.includes(n.category));
    })),
    [model],
  );
  const effectiveFilterMode =
    MODES_NARROW_TO_WIDE.slice(MODES_NARROW_TO_WIDE.indexOf(filterMode)).find((mode) => !emptyModes.has(mode)) ?? 'advanced';

  // Memoized on (model, effectiveFilterMode): these feed the canvas's layout memo, so new
  // references on a selection-only render would re-run Dagre on each click.
  const { visibleNodeIds, filteredEdges, hiddenNodes } = useMemo(() => {
    const allowedCategories = CATEGORY_BY_MODE[effectiveFilterMode];
    const visibleNodeIds = new Set<string>();
    if (model) {
      for (const n of model.nodes) {
        const keep = !allowedCategories || allowedCategories.includes(n.category);
        if (keep) visibleNodeIds.add(n.id);
      }
    }
    const filteredEdges = model ? collapseHiddenEdges(model.edges, visibleNodeIds) : [];
    const hiddenNodes = model ? model.nodes.filter((n) => !visibleNodeIds.has(n.id)) : [];
    return { visibleNodeIds, filteredEdges, hiddenNodes };
  }, [model, effectiveFilterMode]);

  // A picked node only counts while it is on screen in this view.
  const selectedNodeId = view.selectedNodeId != null && visibleNodeIds.has(view.selectedNodeId) ? view.selectedNodeId : null;

  useEffect(() => {
    // The Radix dialog's Escape listener does not stop propagation, so skip while
    // it is open or one press would also close the route.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || guardrailOpen) return;
      if (stagePanelId != null) setStagePanelId(null);
      else if (selectedNodeId) dispatch({ type: 'selectNode', id: null });
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, guardrailOpen, stagePanelId, selectedNodeId]);

  // Expand to the full plan, through the guardrail when it is oversized. `jumpTo` is the paired
  // node to select once the full plan is showing.
  function expandToFull(jumpTo: string | null) {
    const candidateModel = planTree
      ? memoizedBuildPlanGraphModel(planTree, { scope: 'full', stageId: focusStageId, appModel, findings, durationMode }, showInfo)
      : null;
    if (candidateModel && candidateModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD) {
      setExpandRequest({ jumpTo });
    } else {
      dispatch({ type: 'setScope', scope: 'full', jumpTo: jumpTo ?? undefined });
      setFitSignal((s) => s + 1);
    }
  }

  function handleBackToSegment() {
    dispatch({ type: 'setScope', scope: 'segment' });
    setFitSignal((s) => s + 1);
  }

  // Jump to the paired Exchange half: directly when it is rendered, otherwise
  // expand (through the guardrail) with the partner as the node to select.
  function handleJumpToPaired(pairedNodeId: string) {
    if (model?.nodes.some((n) => n.id === pairedNodeId)) dispatch({ type: 'jumpTo', id: pairedNodeId });
    else expandToFull(pairedNodeId);
  }

  // Focus another stage's segment view from the full graph. Every stage box in
  // full scope belongs to the same SQL execution, so the plan tree is unchanged.
  // Bumps fitSignal because the canvas stays mounted and would keep the full
  // plan's pan/zoom. Stable identity matters: it feeds the canvas's layout memo,
  // so a fresh reference per render would re-run Dagre on every selection.
  const handleSelectStage = useCallback((newStageId: StageId) => {
    dispatch({ type: 'focusStage', stageId: newStageId });
    setInitialFullResolved(true);
    setExpandRequest(null);
    setFitSignal((s) => s + 1);
  }, []);

  function handleExpandConfirm() {
    setInitialFullResolved(true);
    dispatch({ type: 'setScope', scope: 'full', jumpTo: expandRequest?.jumpTo ?? undefined });
    setExpandRequest(null);
    setFitSignal((s) => s + 1);
  }

  function handleExpandCancel() {
    // Abandons any paired-node jump that was waiting on this expansion.
    setExpandRequest(null);
    if (initialFullOversized) {
      setInitialFullResolved(true);
      dispatch({ type: 'setScope', scope: 'segment' });
      // If even the segment request resolves to this same oversized full
      // model, keep it blocked without immediately reopening the dialog.
      if (segmentModel?.scope === 'full') setDismissedView(fallbackView);
    }
    // Only the fallback path needs a dismissal: it has no ungated segment view,
    // so the dialog would reopen on the next render.
    if (segmentFellBackUnguarded) setDismissedView(fallbackView);
  }

  function handlePickRecent(id: string) {
    // pickRecent's cached path mutates the live appModel in place. Tear down
    // this route synchronously first so it can never render graph state from
    // the outgoing run against the incoming snapshot.
    onClose();
    return onPickRecent(id);
  }

  // Keyed off the rendered `model.scope`: a segment request that fell back to a
  // small full model leaves `requestedScope` at 'segment'.
  const showingFullPlan = model?.scope === 'full';

  // After the automatic fallback there is no segment view to return to; only an
  // explicit expand guarantees one.
  const canReturnToSegment = requestedScope === 'full';

  const backDisabledReasonId = useId();
  const backDisabled = showingFullPlan && !canReturnToSegment;

  return (
    <div
      // Same marker as Dashboard: a host page can key off it to hide its chrome.
      data-testid="dashboard"
      className="flex h-screen flex-col"
      // Reserve room for the fixed docs panel (published via --docs-inset by
      // DocsSheet); 0px when closed, so the graph reflows into the space left.
      style={{ paddingRight: 'var(--docs-inset, 0px)' }}
    >
      <Topbar
        onLoadNew={resetToDropZone}
        recentEntries={recentEntries}
        activeFileId={activeFileId}
        onPickRecent={handlePickRecent}
        onRemoveRecent={onRemoveRecent}
        leadingContent={
          <div className="flex h-15 min-w-0 flex-col justify-center gap-tight">
            <h1 className="truncate font-heading text-sm font-semibold">Plan graph: Stage {focusStageId}</h1>
            {model && model.scope === 'segment' ? (
              <p className="truncate text-xs text-muted-foreground">
                Segment {(model.segmentIndex as number) + 1} of {model.segmentCount}
              </p>
            ) : null}
            <p className="truncate text-xs text-muted-foreground">
              <DocsLink anchor="#bottleneck-duplicate-plan-subtree">Plan Advisor docs</DocsLink>
            </p>
          </div>
        }
        sectionControls={
          <>
            <div className="flex flex-col items-end gap-0.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={backDisabled}
                aria-describedby={backDisabled ? backDisabledReasonId : undefined}
                onClick={showingFullPlan ? handleBackToSegment : () => expandToFull(null)}
              >
                {showingFullPlan ? 'Back to segment view' : 'Expand to full plan'}
              </Button>
              {backDisabled ? (
                <p id={backDisabledReasonId} className="text-xs text-muted-foreground">
                  This stage's plan couldn't be scoped to a single segment
                </p>
              ) : null}
            </div>
            <Button variant="ghost" size="sm" onClick={onClose}>Close</Button>
          </>
        }
      />
      <div className="flex flex-1 flex-col overflow-hidden">
        {initialFullOversized ? null : !planTree || !model ? (
          <p role="alert" className="p-6 text-sm text-destructive">
            {segmentFellBackOversized
              ? 'This plan has more nodes than the graph view can safely render without expanding. Click "Expand to full plan" to confirm.'
              : "Couldn't build the plan graph for this stage."}
          </p>
        ) : (
          <StageSelectionProvider value={stageSelection}>
          <PlanGraphCanvas
            model={model}
            visibleNodeIds={visibleNodeIds}
            visibleEdges={filteredEdges}
            showMiniMap
            findings={findings}
            stageId={focusStageId}
            segmentStageIds={model.segmentStageIds}
            onSelectStage={handleSelectStage}
            selectedNodeId={selectedNodeId}
            onSelectNode={selectNode}
            stagePanel={panelStage ? (
              <PlanGraphStageDetail
                stage={panelStage}
                catalog={catalog}
                showInfo={showInfo}
                entryRef={stageEntryRef}
                onOpenFullDetails={() => openStage(panelStage.id)}
                onClose={() => setStagePanelId(null)}
              />
            ) : null}
            onJumpToPaired={handleJumpToPaired}
            centerRequest={centerRequest}
            fitSignal={fitSignal}
            filterMode={effectiveFilterMode}
            onFilterModeChange={setFilterMode}
            hiddenCount={hiddenNodes.length}
            emptyFilterModes={emptyModes}
            durationMode={durationMode}
            onDurationModeChange={setDurationMode}
            showInfo={showInfo}
            onShowInfoChange={setShowInfo}
            infoNoteCount={infoNoteCount}
          />
          </StageSelectionProvider>
        )}
      </div>
      <ExpandConfirmDialog
        open={guardrailOpen}
        nodeCount={fullModel?.nodes.length ?? 0}
        onConfirm={handleExpandConfirm}
        onCancel={handleExpandCancel}
      />
      {dialogMounted ? <StageDetailDialog appModel={appModel} catalog={catalog} getTaskData={getTaskData} showInfo={showInfo} /> : null}
    </div>
  );
}
