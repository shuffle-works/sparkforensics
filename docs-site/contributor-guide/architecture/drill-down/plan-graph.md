# Plan graph view

How the plan graph is modelled and rendered in the drill-down.

`buildPlanGraphModel(planTree, opts)` (`packages/core/src/plan-graph-model.ts`) flattens a
resolved `planTree` into a `{ nodes, edges, segmentIndex, segmentCount, scope,
segmentStageIds, inheritedSegments, stageDurations }` graph shape. `src/view/PlanGraphRoute.tsx` owns the view
state and `src/view/plan-graph/PlanGraphCanvas.tsx` renders the model with
`@xyflow/react` (React Flow, pan/zoom/viewport/MiniMap) and `@dagrejs/dagre`
(node layout, `src/view/plan-graph/dagre-layout.ts`, `rankdir: 'RL'`).

Every `PlanGraphEdge` points `source: parentId, target: id` (parent/consumer →
child/producer), and dagre places an edge's source at the higher-rank end. So
`RL`, rather than the more intuitive-looking `LR`, is what lands reads/scans
(targets, computed first) on the left and the final write/root (source) on the
right, matching the left-to-right reading order of the plan's data flow. Each
node's React Flow `Handle`s follow the same horizontal routing: `type="target"`
on `Position.Right` (its parent sits to the right) and `type="source"` on
`Position.Left` (its children sit to the left).

The desktop layout is always this one right-to-left flow, at every canvas size:
an ancestor is always to the right of its descendant, in reading order, and a
long chain scrolls sideways at the readable zoom rather than wrapping into rows.
Only a phone-width viewport (below Tailwind's `sm` breakpoint, 640px,
`useNarrowViewport.ts`) lays a plan of at most 150 operators out `BT`, the same
arrangement stacked vertically with reads/scans on top, so it scrolls down
instead. A `BT` node's handles move to `Position.Bottom` (target) and
`Position.Top` (source) through the `sourcePosition`/`targetPosition` the canvas
sets on it.

`layoutWithDagre` caches positions by topology: the direction, each node's id and
group, and the edges. Switching the duration attribution (same topology, new node
data) or returning to a node filter or scope already laid out reads the positions
back instead of running dagre again, which costs about 1ms per node. The cache
holds the six most recently used layouts, and a layout that throws is not cached.

Dagre orders the segment groups of a compound graph with a constraint graph built
from the order it gave each rank. Three groups whose rank ranges overlap can form
a cycle in it, and Dagre then drops those groups from the next sweep, leaving two
nodes on one (rank, order) slot and throwing "Not possible to find intersection
inside of the rectangle". `runDagre` orders through `orderGroups`: when nodes share a
slot it orders again with every pair of groups that share a rank pinned to one
fixed left-to-right order. Dagre can still drop nodes then, because the constraints
it adds from the observed order can contradict the fixed one, so `separateSharedSlots`
moves any nodes left on one slot to consecutive slots. A graph with no shared slot is
ordered exactly as by default.

A cold layout of a plan with 200 or more nodes runs in a Web Worker
(`layout.worker.ts`, started by `layout-worker-client.ts`) so the page stays
responsive while Dagre works. `PlanGraphCanvas` asks `useLayoutPrewarm` for the
layouts it needs; the hook sends each uncached one to the worker as plain data
(`pendingLayoutJob`), stores the reply with `storeLayout`, and the canvas then
calls `layoutWithDagre`, which finds the positions in the cache. The worker
runs the same `runDagre` as the main thread, so the positions are identical.
While the layout runs, the first open shows `LayoutProgress`: an indeterminate
progress bar under "Laying out plan graph…", centered in the canvas. A later
relayout keeps the previous graph on screen and shows the same bar in a banner. Smaller
graphs, an environment without Web Workers (the single-file export is opened from
`file://`), a worker that fails to start or dies, and a layout that throws all
take the main-thread path. The route starts the worker as soon as the expand
guardrail dialog opens.

The canvas mounts only after the layout lands, and its first fit is the same
full overview as the rail's "Fit to view" (`FIT_TO_VIEW_OPTIONS`). Every automatic
re-fit after that (a scope switch, a resize) goes through `useReadableFit`, which clamps the zoom to at least
`MIN_READABLE_ZOOM` (1.1, so the smallest node text, 10px, renders at 11px on
screen). A graph too large to fit at that zoom overflows the canvas and is
panned instead of shrunk: centered on an axis that fits, anchored to the start
(left/top) on an axis that overflows. The rail's "Fit to view" is the one-click
full overview: a plain `fitView` with no zoom floor, as is the first fit.

`PlanGraphNode.tsx` renders every node at a fixed `NODE_WIDTH × NODE_HEIGHT`
(220×90, also what dagre lays the graph out around) with `truncate`/`title` on
every text field. An operator with an unusually long label/detail/metric string
can't inflate the box and overlap neighbors; it ellipsizes instead, full text on
hover.

Every raw `Exchange`/`BroadcastExchange` plan node is split by `resolvePlanTree`
(`packages/core/src/event-handlers.ts`) into paired write/read halves sharing a
`sourceNodeId` once flattened into the graph. `ReusedExchange` is classified as
an exchange for display purposes but is never split: it carries no
`exchangeRole` and stays a single node. The write half is grouped with its
children's producer component; the read half is grouped with its parent's
consumer component. Both halves get their own entry in `buildDurationMap`'s
duration share. The read half has no metrics of its own and no
same-segment descendants, so its share is 0 in exclusive and inclusive mode
alike, and `PlanGraphNode.tsx` shows it as a 0% heat bar next to a "paired:
see write half" note. The canvas leaves the share out of the read half's
accessible label.

Default scope is `segment`: one Exchange-bounded slice of the plan, resolved via
`computeSegments`/`zipSegmentsToStages` (`packages/core/src/plan-duration-attribution.ts`,
shared with `attributeStageDurationToPlan`). `computeSegments` gives every
connected component a stable pre-order identity plus separate
parent/depth/traversal metadata. The numeric identity does not encode
Exchange-ancestor depth: `zipSegmentsToStages` orders by the explicit depth
metadata (deepest first, plan traversal order for ties). `linkSegmentsToStages`
adds a link for every segment: a strictly paired segment gets its own stage, and a
segment the zip left unpaired takes the nearest strictly paired segment's stage
(component-tree edge distance) and is marked inherited. The model carries the
labels as `segmentStageIds` and the inherited segments as `inheritedSegments`.

The view has an opt-in "Expand to full plan" toggle gated by a 300-node
confirmation dialog (`ExpandConfirmDialog.tsx`). A segment-lookup failure that
would otherwise render an unguarded full plan is routed through the same
guardrail rather than bypassing it. That same failure can also resolve to a
full-scope model _below_ the guardrail threshold, rendering immediately with no
dialog and no `requestedScope` change. Since it's a permanent property of that
stage's plan (`buildPlanGraphModel` is deterministic per `(planTree, stageId,
appModel)`), there is no segment view left for that stage to switch back to. So
the toggle, still correctly labeled "Back to segment view" per `model?.scope`,
renders `disabled` rather than silently no-opping on click. Only the
explicit-expand path (`requestedScope === 'full'`) leaves it enabled.

An oversized fallback or an oversized `initialScope: 'full'` open withholds the
graph model until the dialog is confirmed. Dismissing the dialog closes it but
does not lift that block, and a dismissed fallback does not reopen the dialog,
because the stage has no ungated segment view to show instead.

The seven Plan Advisor finding types (`duplicatePlanSubtree`, `smallFiles`,
`nestedLoopJoin`, `mergeRewrite`, `pythonUdf`, and `broadcastSizing`'s `overBroadcast`/`underBroadcast`, in
`packages/core/src/detectors.ts`) set `Finding.planNodeIds`, an unambiguous
pointer to the specific plan-tree node(s) each finding is about (every node of
each repeated subtree occurrence for `duplicatePlanSubtree`, the flagged
scan/write node for `smallFiles`, the join node for `nestedLoopJoin`, the MERGE command node for `mergeRewrite`, the `BatchEvalPython` nodes for `pythonUdf`, the shuffle `data size`
Exchange node under each of the two join inputs for `underBroadcast`, and the BroadcastExchange node for
`overBroadcast`). `buildPlanGraphModel`
indexes `findings` by `planNodeIds` and attaches each node's matches to its
`PlanGraphNodeData.findings`, scoped to the current SQL execution (see
below), and `PlanGraphNode.tsx` renders a corner badge from that per-node
list. The badge follows the same dot+tag problem-flagging vocabulary as the
rest of the dashboard: an `ImpactDot` plus the ALL-CAPS `typeTag` (`PLAN`
for every current plan-node finding), colored by the worst band across the
node's findings (critical > warning > info, via the local `worstFinding`
helper), plus a count when the node carries more than one finding. Hovering
or focusing the badge opens a tooltip listing each finding by its
`findingActionLabel` (e.g. "Dedupe repeated subtree", "Compact small
files"), so the node discloses which findings hit it without leaving the
graph. Every other finding type has no plan-node pointer and renders
at the stage level only, via `Finding.stageId`/`Finding.stageIds`.

`resolvePlanTree` prefixes every plan-node id with its owning SQL execution
(`e<executionId>:n0`, `e<executionId>:n1`, ...), so ids are unique across
executions. `buildPlanGraphModel` also filters `findings` to
`finding.executionId === sqlExecutionId` (the execution the stage being
graphed belongs to) before indexing by node id, as defense in depth: a
hand-built or stale finding whose `planNodeIds` collide with this tree's ids
still can't badge onto the wrong tree.

`PlanGraphRoute` passes the model, the stage boxes and "Next problem" the catalog
narrowed by `filterFindings(catalog, emptySelection())`, the dashboard's default
band filter, so info findings are absent until the Settings "Show info notes"
checkbox is on. The model cache key includes that choice. The "Open plan graph"
picker counts the same narrowed list. `StageDetailDialog` applies the same
default ([Drill-down](../drill-down.md)).

Two other per-node UI features render independently of findings:

- A traffic-light **duration heat bar** on each node
  (`plan-graph-heat.ts`'s `heatBand`, consumed by `PlanGraphNode.tsx`) bands
  the node's duration share into critical/warning/info, reusing the
  impact-band color tokens (see the Plan Violet exception noted in
  `DESIGN.md`).
- A **duration-attribution mode toggle**
  (`PlanGraphDurationModeControl.tsx`) switches every node's displayed
  share between "Node only" (exclusive) and "Node + descendants"
  (inclusive), threaded into the model-build/cache key as `durationMode`.

One more identity subtlety: a split `Exchange`/`BroadcastExchange` pair
(the write/read halves `resolvePlanTree` synthesizes, see above) counts as
**one** node for `duplicatePlanSubtree`'s subtree-size and occurrence
counting. `computePlanShapes` in `detectors.ts` walks straight through the
read half to the write half's real children, so every real Exchange in a
matched subtree is counted once instead of twice.

Each stage is drawn as one stroked box, `PlanGraphStageGroupNode.tsx` (Dagre
`compound: true` for spacing, `computeGroupBounds` for the bounds), in both the
default single-stage view and the expanded full-plan view. The box wraps the one
Exchange-bounded segment the log strictly pairs with that stage, so it can never
enclose a node of another stage. It is the only stroked box around that segment
and the only one that rings on selection. Its header holds the "Stage N"
title, a duration chip with the stage's exclusive duration
(`PlanGraphModel.stageDurations`, computed over the whole plan, so the single-stage
view shows the same total; omitted when none is attributed), and one finding chip
(`PlanGraphFindingChip`) per finding on the stage, in that order. Each chip is a
button holding a plain `TagBadge` (the ALL-CAPS tag, with no docs link)
followed by the finding's compact magnitude and recoverable-time detail from
`formatFindingChipDetail` (e.g. "SPILL 4.2 GB · ~38s": the finding's own
`value`/`metric` and its `impactEstimate.wallClock`), or the bare tag when the
finding carries neither. A chip and every "Stage N" title (`StageEntryButton`,
`stage-selection.tsx`) opens that stage's findings panel (see below); both carry
`tap-target-comfortable`, which lifts the 10px-tall chip to a 24px hit area (44px on
touch). Outside a `StageSelectionProvider` they render as plain text.

A segment with no stage pair of its own (an inherited segment, or one with no
stage label at all) has no stage box. `PlanGraphSegmentGroupNode.tsx` draws it as a
dashed box with a "Stage —" header, a "nearest: Stage N" note when the model
labels it, and its own duration chip (an em-dash placeholder when it has no
attributed duration). An inherited segment adds nothing to its nearest stage's
duration or findings. The paint order is the dashed segment boxes, then the stage
boxes, then the plan nodes, all above the edge layer so a routed edge can't paint
over a box's finding chips.

Chips match a stage through `Finding.stageId` or `Finding.stageIds`. In the full
plan, clicking a stage box ("Focus stage N") switches the route to that stage's
segment view (`handleSelectStage` in `PlanGraphRoute.tsx`), with no reopen; the
single-stage view draws no such click target. The header sits inside the box, in
the room above its segment. The padded boxes of adjacent stages can partly
overlap, so stage boxes paint in top-edge order: a header stays above the box it
overlaps and its title stays clickable. A focal
stage with findings that lost the segment/stage pairing has no paired segment
and no box. `PlanGraphUnmatchedStageNode` draws its header alone above the
graph, with the same title, duration chip and finding chips plus a note that it
is not matched to a part of the plan. It encloses no node, and "Next problem"
cycles to it in the full plan.

The stage box wraps its paired segment's plan nodes directly. `STAGE_GROUP_PADDING_Y`
(64, no reserved header height) leaves room above the nodes for the header, with
room to wrap it onto a second row. `STAGE_GROUP_PADDING_BOTTOM` (32) matches
`STAGE_GROUP_PADDING_X` (32), as nothing is painted below the nodes, and the
sideways padding stays small so the box doesn't visibly balloon.

Every global control lives on one **vertical control rail** down the left edge
(`PlanGraphControlRail.tsx`), grouped View / Navigate / Display, so nothing
floats in its own corner. View is zoom in/out and fit (in place of React Flow's
`Controls`); Navigate is "Next worst duration" and "Next problem" (cycling to
the worst-share node and to the problem stages in the verdict's order
(`orderByImpact`), via `setCenter`); Display is
the node-filter/duration/info-notes Settings popover (`PlanGraphSettingsControl` with its
`iconOnly` rail variant), plus the legend and minimap
toggles. The rail renders inside `ReactFlowProvider` alongside `<ReactFlow>`, so
its `useReactFlow` zoom/center calls drive the same instance.

Clicking a node opens the **detail inspector** (`PlanGraphNodeDetail.tsx`), a
right-docked panel (not a floating card) that reflows the graph rather than
covering it. Below Tailwind's `sm` breakpoint (640px, `useNarrowViewport.ts`)
it is a bottom sheet about 40 percent tall instead, with a grabber that
dismisses it on a downward swipe; while it is open the canvas pans the
selected node to the middle of the remaining pane and hides the legend and
minimap. Each node box is a fixed size and truncates every field to one
line, showing a single `primaryMetric`; the inspector is where the whole
operator is legible: category and segment, duration share, the node's findings
(dot + tag + `findingActionLabel`), the operator's **full metric set**
(`PlanGraphNodeData.metrics`, every metric formatted through
`formatPlanMetricValue`), and the **complete plan text**
(`PlanGraphNodeData.detailText`, the untruncated `PlanNode.detail`). For a split
Exchange half the inspector adds an **Exchange section**: which half is in view,
the shuffle volume across the boundary (`PlanGraphNodeData.exchangeShuffleBytes`,
the same producing-stage bytes the pairing edge is weighted by, mirrored onto
both halves so it shows whichever half is open, or "Broadcast, no shuffle"), the
width of its rows (`PlanGraphNodeData.exchangeWidth`, from `PlanNode.rowWidth`,
which `resolvePlanTree` sets on every exchange whose columns or bytes per row are
known), and a **jump to the paired half** (`PlanGraphNodeData.pairedNodeId`). A
`ReusedExchange` is never split, so its Exchange section shows only the row width,
and only when it is known. Because the two
halves always sit in different segments, the jump selects the partner directly
when it is already on screen (full plan) and otherwise expands to the full plan
first, then selects it (`handleJumpToPaired` in `PlanGraphRoute.tsx`, carried
past the selection-reset effect by a pending-jump state); either way the canvas
recenters on it via a `centerRequest` token. The selected node id lives in
`PlanGraphRoute.tsx`, not the canvas, so the route's one Escape handler closes
the inspector first and the whole route only on a second press. Nodes are
`draggable: false` (a read-only, auto-laid-out graph); they click to inspect but
don't move.

Selecting a stage (a chip or a "Stage N" title) fills the same inspector slot
with the **stage panel** (`PlanGraphStageDetail.tsx`), 384px wide when docked and
the same 40 percent bottom sheet on a phone (which hides the legend and minimap while it is up), so the graph stays on screen. Both
inspectors sit in `PlanGraphInspector.tsx`, which owns the dock and sheet layout,
the grabber and the title row. The selected stage's boxes get a ring. The panel
holds the findings block of the stage detail dialog, `StageFindings`
(`widgets/StageFindings.tsx`, shared with the dialog so the text cannot differ),
and an **Open full stage details** button. The tag in the panel is the docs link.
The panel and the node detail replace each other: `PlanGraphRoute.tsx` owns both
selections, and selecting a node clears the stage and the reverse. Escape closes
one level per press: the stage detail dialog, the panel or the node detail, then
the route. Focus moves into the panel when it opens, and back to the chip or title
that opened it when it closes, unless focus has already moved elsewhere.

The button opens the existing `StageDetailDialog`, which the route mounts the same
way the dashboard does (without `onRoute`, so it shows no **Show evidence**
buttons), with `showInfo` following the graph's Settings. The dialog's open state
sits above both routes, so the route clears it when it mounts and mounts the dialog
after: a dialog left open on the dashboard does not appear over the graph. The
dialog's own **View plan graph** button is hidden while the graph is active
(`PlanView.tsx`).

The remaining legibility aids sit on the canvas itself:

- The **MiniMap** (bottom-right) shows by default only while part of the graph
  is off screen; a click on the rail's toggle forces it on or off from then on,
  and the toggle's pressed state always matches whether it is on screen. It
  colors each node by the
  worst finding band on it (`planGraphMiniMapNodeColor`, `plan-graph-minimap.ts`),
  so the overview shows where the problems are; a node with no finding keeps the
  neutral plan color and the large group boxes recede into a muted fill.
- A **legend** panel (`PlanGraphLegend.tsx`, collapsed by default, toggled from the
  rail) keys the operator icons, the heat-bar colors, the shuffle-weighted edge
  thickness, the stage box and the dashed box of a segment with no stage of its own.

The view is reached from a "View plan graph" button in `PlanView.tsx`'s toolbar
(gated by the same `if (dot)` check described in "Plan DOT serialization"
above), which opens the stage's segment, and from the topbar's graph-view
control, which opens the full plan (`initialScope: 'full'`, still behind the
300-node guardrail). Both set a `planGraph: { active, stageId, initialScope }`
Zustand slice
(`openPlanGraph`/`closePlanGraph`, `src/store/store.ts`) driving a top-level
`AppRoutes` branch in `src/App.tsx`, modeled on the
`comparison`/`RunComparisonRoute` full-takeover pattern.

`buildPlanGraphModel`'s output is memoized per `(activeFileId, stageId, scope, durationMode)`
in `PlanGraphRoute.tsx`, since `stageId` alone isn't unique across loaded runs
and `applySnapshot` mutates `appModel` in place rather than replacing it (see
[State model](../state-and-history.md#state-model)). The memo cache is a
module-level `Map`, so it survives across route open/close: re-opening the same
stage in the same run reuses the cached model instead of rebuilding it. It must
still be evicted on a fresh parse or reload. `resetModel()` (`store.ts`) bumps a
`modelResetCount` counter for exactly this purpose, and `PlanGraphRoute.tsx`
subscribes to it to clear the cache. A counter rather than a direct call, since
`store.ts` has no view-layer imports anywhere else and importing a `.tsx` module
there would invert that dependency direction.

## Duration share

`exclusiveDurationShare` is a non-overlapping partition of each stage's wall
time. The mode-selected `durationShare` equals it in exclusive mode but adds
every descendant's time into each ancestor in inclusive mode. `PlanGraphCanvas`
therefore divides each node's share by the sum of the exclusive shares, and labels
a stage box with its exclusive duration, so neither number grows with tree depth
when the mode flips. A hand-built node without the exclusive field falls back to
`durationShare`.

## Layout ordering and cost

`runDagre` uses the `tight-tree` ranker rather than Dagre's default
`network-simplex`: a plan is a tree plus the Exchange read/write split, so
`tight-tree` assigns the ranks a tree wants at a fraction of the cost on a compound
graph. `longest-path` is faster still but places nodes degenerately. `nodesep` in
`RL` is `2 * STAGE_GROUP_PADDING_Y`, so two vertically stacked stage boxes
(each reserving that padding above its members and `STAGE_GROUP_PADDING_BOTTOM`
below) cannot overlap; `BT`
swaps the axes, with `ranksep` at that floor and `nodesep` at
`2 * STAGE_GROUP_PADDING_X` plus a gap. The compound-graph ordering fallback
(`orderGroups`) is described above.

Calibration data for the layout cost:

| Measure | Value |
|---|---|
| Compound layout of a 400-node plan, `network-simplex` | about 1,600 ms |
| Same plan, `tight-tree` | about 500 ms |
| Dagre pass cost | about 1 ms per node |
| Stage boxes overlapped without the `nodesep` floor | by about 48 px |
| Worker threshold (`WORKER_LAYOUT_MIN_NODES`) | 200 nodes |
