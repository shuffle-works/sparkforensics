import { useCallback, useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { resolvePlanTree } from '@/view/widgets/PlanView';
import { buildPlanGraphModel } from '@sparkforensics/core/plan-graph-model.ts';
import { store } from '@/store/store';
import { PlanGraphCanvas, type CenterRequest } from '@/view/plan-graph/PlanGraphCanvas';
import { ExpandConfirmDialog } from '@/view/plan-graph/ExpandConfirmDialog';
import { Topbar } from '@/view/Topbar';
import { DocsLink } from '@/view/DocsContext';
import { useIngest } from '@/store/useIngest';
import { useRecentFiles } from '@/view/useRecentFiles';
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

// Module-level memo cache: buildPlanGraphModel walks and re-derives the
// whole plan tree (segment computation, duration attribution) on top of the
// already-split tree it's handed, the Exchange write/read split itself
// happens upstream, in resolvePlanTree (event-handlers.ts), which is wasted
// work to redo on every re-render or re-open of the same stage. Keyed on
// (activeFileId, stageId, scope, durationMode) rather than stageId alone,
// since stageId isn't unique across loaded runs, applySnapshot mutates
// appModel in place rather than replacing it, and a duration-mode flip needs
// its own cached model (see the "Plan graph view" section in
// docs-site/contributor-guide/architecture/drill-down.md).
type CacheKey = string;
const planGraphModelCache = new Map<CacheKey, PlanGraphModel>();

function cacheKey(activeFileId: string | null, stageId: StageId, scope: 'segment' | 'full', durationMode: PlanGraphDurationMode): CacheKey {
  return `${activeFileId ?? 'none'}::${stageId}::${scope}::${durationMode}`;
}

/** Exposed for tests: clears every memoized model, e.g. between test cases
 * so a stale entry from one test can't leak into the next. Production code
 * never calls this directly; see the store.subscribe wiring below, which
 * calls it in response to resetModel() (a fresh parse/reload). */
export function clearPlanGraphModelCache(): void {
  planGraphModelCache.clear();
}

// resetModel() (a fresh file load/reparse) must evict this cache; otherwise
// a new run sharing the same activeFileId/stageId/scope as a prior one (e.g.
// reloading the same file) would render a stale model. store.ts can't import
// this view-layer module to call clearPlanGraphModelCache() directly without
// inverting the app's store -> view dependency direction (store.ts has no
// React/view imports anywhere else), so this subscribes to the store's
// `modelResetCount` counter (bumped only by resetModel()) instead.
let lastModelResetCount = store.getState().modelResetCount;
store.subscribe((state) => {
  if (state.modelResetCount !== lastModelResetCount) {
    lastModelResetCount = state.modelResetCount;
    clearPlanGraphModelCache();
  }
});

function memoizedBuildPlanGraphModel(
  planTree: NonNullable<ReturnType<typeof resolvePlanTree>>,
  opts: { scope: 'segment' | 'full'; stageId: StageId; appModel: AppModel; findings: Finding[]; durationMode: PlanGraphDurationMode },
  activeFileId: string | null,
): PlanGraphModel | null {
  const key = cacheKey(activeFileId, opts.stageId, opts.scope, opts.durationMode);
  const cached = planGraphModelCache.get(key);
  if (cached) return cached;
  const result = safeBuildPlanGraphModel(planTree, opts);
  if (result) planGraphModelCache.set(key, result);
  return result;
}

export function PlanGraphRoute({ stageId, appModel, findings, activeFileId, onClose, initialScope }: PlanGraphRouteProps) {
  const { resetToDropZone } = useIngest();
  const { recentEntries, onPickRecent, onRemoveRecent } = useRecentFiles(activeFileId);
  const [filterMode, setFilterMode] = useState<PlanGraphFilterMode>('basic');
  const [durationMode, setDurationMode] = useState<PlanGraphDurationMode>('exclusive');
  const [requestedScope, setRequestedScope] = useState<'segment' | 'full'>(initialScope ?? 'segment');
  const [confirmExpandOpen, setConfirmExpandOpen] = useState(false);
  const [initialFullResolved, setInitialFullResolved] = useState(initialScope !== 'full');
  const [fallbackDismissed, setFallbackDismissed] = useState(false);
  // Which stage's plan segment is currently in view. Seeded from the stageId
  // prop and only re-seeded on a genuine remount (App.tsx's key={stageId});
  // clicking a stage box in the full graph (handleSelectStage, below) moves
  // this without re-opening the whole route or re-resolving appModel.
  const [focusStageId, setFocusStageId] = useState<StageId>(stageId);
  // Id of the plan node whose detail card is open (null = none). Held here, not
  // in the canvas, so the route's single Escape handler can close the card
  // before tearing down the whole route.
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  // Bumped whenever a scope switch (expand/back) should re-fit the viewport, so
  // switching to a much larger or smaller graph doesn't leave the user zoomed
  // into a stale corner. The canvas refits on each change.
  const [fitSignal, setFitSignal] = useState(0);
  // Recenter request for a paired-node jump; the canvas centers on nodeId each
  // time the token increments. Separate from fitSignal so a jump focuses the
  // partner rather than re-fitting the whole graph.
  const [centerRequest, setCenterRequest] = useState<CenterRequest>({ nodeId: null, token: 0 });
  // A paired-node jump whose partner isn't in the current (segment) view: the
  // two Exchange halves always live in different segments, so the jump expands
  // to the full plan and this holds the target until the full model is on
  // screen (see the apply effect below). Null when no jump is pending.
  const [pendingJumpId, setPendingJumpId] = useState<string | null>(null);
  const requestCenter = (nodeId: string) => setCenterRequest((prev) => ({ nodeId, token: prev.token + 1 }));

  // A node id only means something within one stage/scope/filter view; drop the
  // selection when any of those change so a stale id can't leave a card open
  // over a different graph (or over a node the filter just hid).
  useEffect(() => {
    setSelectedNodeId(null);
  }, [focusStageId, requestedScope, filterMode]);

  const planTree = resolvePlanTree(focusStageId, appModel);

  const segmentModel = planTree
    ? memoizedBuildPlanGraphModel(planTree, { scope: 'segment', stageId: focusStageId, appModel, findings, durationMode }, activeFileId)
    : null;

  // A 'segment' request can silently fall back to a 'full' result inside
  // buildPlanGraphModel (segment lookup failure: no sql linkage, or this
  // stage's segment fell outside the Math.min(segments, stages)
  // truncation). Per the design's error-handling requirement, that
  // fallback still has to pass through the same node-count guardrail as an
  // explicit "Expand to full plan" click: never render an unguarded full
  // graph just because scoping failed. This condition intentionally does
  // NOT depend on `fallbackDismissed`: dismissing the dialog closes the
  // dialog, but must not lift the block on rendering the oversized model
  // (see `segmentFellBackUnguarded` below for the flag that does react to
  // dismissal; it only governs whether the dialog re-opens itself).
  const segmentFellBackOversized =
    segmentModel != null &&
    segmentModel.scope === 'full' &&
    requestedScope === 'segment' &&
    segmentModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD;

  // Gates the auto-open effect only: true on first detecting the oversized
  // fallback, false again once the user dismisses the dialog, so the effect
  // below doesn't immediately reopen it every render.
  const segmentFellBackUnguarded = segmentFellBackOversized && !fallbackDismissed;

  useEffect(() => {
    if (segmentFellBackUnguarded) setConfirmExpandOpen(true);
  }, [segmentFellBackUnguarded]);

  const fullModel = planTree && (requestedScope === 'full' || confirmExpandOpen)
    ? memoizedBuildPlanGraphModel(planTree, { scope: 'full', stageId: focusStageId, appModel, findings, durationMode }, activeFileId)
    : null;

  // Topbar opens request full scope immediately. That route boundary must use
  // the same node-count guard as the in-route expansion button instead of
  // treating `initialScope: 'full'` as blanket consent to render any size.
  // The derived condition opens the dialog on the first render and withholds
  // every graph model until confirm/cancel resolves the requested scope.
  const initialFullOversized =
    !initialFullResolved &&
    requestedScope === 'full' &&
    fullModel != null &&
    fullModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD;
  const guardrailOpen = confirmExpandOpen || initialFullOversized;

  useEffect(() => {
    // ExpandConfirmDialog (Radix Dialog) has its own Escape listener and
    // doesn't stop propagation, so without this guard, pressing Escape while
    // only the guardrail dialog is open would both close the dialog AND tear
    // down this whole full-screen route out from under the user.
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || guardrailOpen) return;
      // Escape closes the node detail card first, then (on a second press,
      // with nothing else open) the route itself.
      if (selectedNodeId) setSelectedNodeId(null);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, guardrailOpen, selectedNodeId]);

  const model = segmentFellBackOversized
    ? null // held back until requestedScope flips to 'full' via explicit confirm; dismissing the dialog alone must not unblock this
    : initialFullOversized
      ? null
    : requestedScope === 'full'
      ? fullModel
      : segmentModel;

  // Apply a pending paired-node jump once its partner is actually on screen.
  // Defined after the selection-reset effect above so that on the render where
  // the scope flips to 'full', this runs last and its selection wins over the
  // reset's clear (both read pendingJumpId from the same render's closure).
  // Guarded on requestedScope === 'full' so it waits through the expand
  // guardrail dialog, and on the node being present so it never selects an id
  // the full model doesn't contain.
  useEffect(() => {
    if (!pendingJumpId || requestedScope !== 'full') return;
    if (!model?.nodes.some((n) => n.id === pendingJumpId)) return;
    setSelectedNodeId(pendingJumpId);
    requestCenter(pendingJumpId);
    setPendingJumpId(null);
  }, [pendingJumpId, requestedScope, model]);

  function handleExpandClick() {
    const candidateModel = planTree
      ? memoizedBuildPlanGraphModel(planTree, { scope: 'full', stageId: focusStageId, appModel, findings, durationMode }, activeFileId)
      : null;
    if (candidateModel && candidateModel.nodes.length > EXPAND_GUARDRAIL_THRESHOLD) {
      setConfirmExpandOpen(true);
    } else {
      setRequestedScope('full');
      setFitSignal((s) => s + 1);
    }
  }

  function handleBackToSegment() {
    setRequestedScope('segment');
    setFitSignal((s) => s + 1);
  }

  // Jump from one split-Exchange half to its paired half (the detail card's
  // "Jump to write/read half"). When both halves are already rendered (full
  // plan), select and recenter the partner directly. Otherwise the partner is
  // in a different Exchange-bounded segment, so expand to the full plan
  // (through the same node-count guardrail as the Expand button) and let the
  // apply effect above select it once the full model is on screen.
  function handleJumpToPaired(pairedNodeId: string) {
    if (model?.nodes.some((n) => n.id === pairedNodeId)) {
      setSelectedNodeId(pairedNodeId);
      requestCenter(pairedNodeId);
      return;
    }
    setPendingJumpId(pairedNodeId);
    handleExpandClick();
  }

  // Jump focus to a different stage's segment view from the full graph
  // (PlanGraphCanvas's onSelectStage). Every stage box shown in scope:
  // 'full' belongs to the same SQL execution as the one currently open
  // (resolvePlanTree(newStageId, appModel) resolves to the same linkedSql),
  // so this never needs to re-resolve a different plan tree.
  //
  // Bumps fitSignal like every other scope switch: this collapses the full plan
  // down to one stage's segment while the canvas stays mounted, so the mount-
  // time fitView never re-fires and, without this, the viewport would keep the
  // full plan's pan/zoom and strand the user in a corner of the new graph.
  //
  // Stable identity (useCallback, only setState setters as deps) matters: this
  // is a dependency of the canvas's layout memo, so a fresh reference each
  // render would invalidate that memo and re-run Dagre on every selection.
  const handleSelectStage = useCallback((newStageId: StageId) => {
    setFocusStageId(newStageId);
    setRequestedScope('segment');
    setInitialFullResolved(true);
    setFallbackDismissed(false);
    setPendingJumpId(null);
    setFitSignal((s) => s + 1);
  }, []);

  function handleExpandConfirm() {
    setInitialFullResolved(true);
    setRequestedScope('full');
    setConfirmExpandOpen(false);
    setFitSignal((s) => s + 1);
  }

  function handleExpandCancel() {
    setConfirmExpandOpen(false);
    // Abandon any paired-node jump that was waiting on this expansion.
    setPendingJumpId(null);
    if (initialFullOversized) {
      setInitialFullResolved(true);
      setRequestedScope('segment');
      // If even the segment request resolves to this same oversized full
      // model, keep it blocked without immediately reopening the dialog.
      if (segmentModel?.scope === 'full') setFallbackDismissed(true);
    }
    // Only the fallback path needs a dismiss flag: an explicit "Expand to
    // full plan" click just leaves requestedScope at 'segment' and the
    // segment view renders normally. The fallback path has no ungated
    // segment view to fall back to, so without this flag the guardrail
    // effect above would immediately reopen the dialog on the next render.
    if (segmentFellBackUnguarded) setFallbackDismissed(true);
  }

  function handlePickRecent(id: string) {
    // pickRecent's cached path mutates the live appModel in place. Tear down
    // this route synchronously first so it can never render graph state from
    // the outgoing run against the incoming snapshot.
    onClose();
    return onPickRecent(id);
  }

  // The node filter derives three values the canvas consumes. Memoize them on
  // (model, filterMode) so a render that changes neither (opening a node's
  // detail card only flips local selection state) hands the canvas the same
  // Set/array references. Those feed the canvas's layout memo, so churning them
  // every render would re-run the (expensive) Dagre layout on each click. See
  // the layout-reuse regression test in tests/view/plan-graph-route.test.tsx.
  const { visibleNodeIds, filteredEdges, hiddenNodes } = useMemo(() => {
    const allowedCategories = CATEGORY_BY_MODE[filterMode];
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
  }, [model, filterMode]);

  // Keyed off the actually-rendered `model.scope`, not `requestedScope`
  // alone: a segment request can silently resolve to a 'full' model via the
  // segment-lookup-failure fallback (see `segmentFellBackOversized` above)
  // without the user ever clicking anything, and, when that fallback's
  // node count is at or under the guardrail threshold, it renders
  // immediately with no dialog. `requestedScope` stays 'segment' in that
  // path, so a label keyed on it alone would misreport "Expand to full
  // plan" while the full plan is already on screen.
  const showingFullPlan = model?.scope === 'full';

  // When the full plan is on screen because of the automatic
  // segment-lookup-failure fallback above (`requestedScope` never left
  // 'segment'), buildPlanGraphModel resolves this stage's 'segment' request
  // to 'full' every time; there is no distinct segment view for this stage
  // to switch back to, so back-to-segment is only meaningful when the current
  // full render came from an explicit user request (`requestedScope === 'full'`).
  // That path only exists when `segmentModel.scope` was already 'segment' (see
  // `handleExpandClick`'s guard: it's only wired up while !showingFullPlan),
  // so flipping back is guaranteed to reveal a real segment view.
  const canReturnToSegment = requestedScope === 'full';

  const backDisabledReasonId = useId();
  const backDisabled = showingFullPlan && !canReturnToSegment;

  return (
    <div
      // Shares Dashboard's marker: the host site's chrome-toggle script
      // (shuffle-works-site-build) hides the shared nav/footer while this
      // testid is present, since the graph route also needs the full
      // viewport and otherwise replaces Dashboard's own "dashboard" node
      // (App.tsx renders one or the other, never both).
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
          <div className="min-w-0">
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
                onClick={showingFullPlan ? handleBackToSegment : handleExpandClick}
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
            onSelectNode={setSelectedNodeId}
            onJumpToPaired={handleJumpToPaired}
            centerRequest={centerRequest}
            fitSignal={fitSignal}
            filterMode={filterMode}
            onFilterModeChange={setFilterMode}
            hiddenCount={hiddenNodes.length}
            durationMode={durationMode}
            onDurationModeChange={setDurationMode}
          />
        )}
      </div>
      <ExpandConfirmDialog
        open={guardrailOpen}
        nodeCount={fullModel?.nodes.length ?? 0}
        onConfirm={handleExpandConfirm}
        onCancel={handleExpandCancel}
      />
    </div>
  );
}
