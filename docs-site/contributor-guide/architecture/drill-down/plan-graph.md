# Plan graph view

How the plan graph is modelled and rendered in the drill-down.

`buildPlanGraphModel(planTree, opts)` (`packages/core/src/plan-graph-model.ts`) flattens a
resolved `planTree` into a `{ nodes, edges, segmentIndex, segmentCount, scope,
segmentStageIds }` graph shape. `src/view/PlanGraphRoute.tsx` owns the view
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

A plan too long to fit the canvas at a readable zoom (and of at most 150
operators) is also laid out `BT`, the same arrangement stacked vertically with
reads/scans on top, and the direction that fits larger wins
(`pickDirection`, `readable-fit.ts`). On a landscape canvas that is almost
always `RL`; on a phone-sized one it is `BT`. A `BT` node's handles move to
`Position.Bottom` (target) and `Position.Top` (source) through the
`sourcePosition`/`targetPosition` the canvas sets on it.

Every fit (the mount-time one, a scope switch, a resize, the rail's "Fit to
view") goes through `useReadableFit`, which clamps the zoom to at least
`MIN_READABLE_ZOOM` (1.1, so the smallest node text, 10px, renders at 11px on
screen). A graph too large to fit at that zoom overflows the canvas and is
panned instead of shrunk: centered on an axis that fits, anchored to the start
(left/top) on an axis that overflows.

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
metadata (deepest first, plan traversal order for ties), and the display-only
fallback uses component-tree edge distance to find the nearest strictly paired
component.

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

The six Plan Advisor finding types (`duplicatePlanSubtree`, `smallFiles`,
`nestedLoopJoin`, `pythonUdf`, and `broadcastSizing`'s `overBroadcast`/`underBroadcast`, in
`packages/core/src/detectors.ts`) set `Finding.planNodeIds`, an unambiguous
pointer to the specific plan-tree node(s) each finding is about (every node of
each repeated subtree occurrence for `duplicatePlanSubtree`, the flagged
scan/write node for `smallFiles`, the join node for `nestedLoopJoin`, the `BatchEvalPython` nodes for `pythonUdf`, the shuffle `data size`
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

The segment-level group box (`PlanGraphSegmentGroupNode.tsx`) always renders,
even in the default single-stage view where it's the only box on screen. It is
headered with its stage id (via `segmentStageIds`) and a duration chip, or an
em-dash placeholder when the segment has no attributed duration. It also
carries one finding chip (`PlanGraphFindingChip`) per finding on its zipped
stage, in both the default and the expanded view. Each chip is a `TagBadge` (the ALL-CAPS tag)
followed by the finding's compact magnitude and recoverable-time detail from
`formatFindingChipDetail` (e.g. "SPILL 4.2 GB · ~38s": the finding's own
`value`/`metric` and its `impactEstimate.wallClock`), or the bare tag when the
finding carries neither.

The expanded full-plan view draws two nested layers of background group boxes
(Dagre `compound: true` for spacing, `computeGroupBounds` for both): the same
inner segment box described above, plus an outer solid tinted container per
distinct stage id (`PlanGraphStageGroupNode.tsx`, layered under the inner
segment box, which is in turn under the plan nodes; all three sit above the
edge layer so a routed edge can't paint over a box's finding chips) merging
every segment zipped to that stage, so a stage split
across several Exchange-bounded segments still reads as one unit of work. In
this expanded view the segment box still carries its stage's finding chips
inline in its header row. The outer stage box paints its own copy only as a
fallback, for a stage no segment box is zipped to (for example, the focal stage
when it lost the segment/stage pairing), so every finding appears exactly once.
Chips match a stage through `Finding.stageId` or `Finding.stageIds`; the
default segment scope uses the same matching for its displayed stage. Clicking
an outer stage box ("Focus stage N") switches the route to that stage's segment
view (`handleSelectStage` in `PlanGraphRoute.tsx`), with no reopen.

The outer layer's own corner tag is positioned opposite the segment box's
top-left header, because a stage with just one segment (the common case) would
otherwise show the same "Stage N" header twice, stacked. `STAGE_GROUP_PADDING_Y`
(64, no reserved header height) is sized to strictly exceed the segment layer's
own reserved offset (`GROUP_PADDING + GROUP_HEADER_HEIGHT` = 56 at the top),
while `STAGE_GROUP_PADDING_X` (32) is kept close to `GROUP_PADDING`'s own 24px
floor so the outer box doesn't visibly balloon sideways. Both still strictly
contain the outer box around its nested segment box(es).

Every global control lives on one **vertical control rail** down the left edge
(`PlanGraphControlRail.tsx`), grouped View / Navigate / Display, so nothing
floats in its own corner. View is zoom in/out and fit (in place of React Flow's
`Controls`); Navigate is "Next worst duration" and "Next problem" (cycling to
the worst-share node and the worst-finding stage, via `setCenter`); Display is
the node-filter/duration Settings popover (`PlanGraphSettingsControl` with its
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
both halves so it shows whichever half is open, or "Broadcast, no shuffle"), and
a **jump to the paired half** (`PlanGraphNodeData.pairedNodeId`). Because the two
halves always sit in different segments, the jump selects the partner directly
when it is already on screen (full plan) and otherwise expands to the full plan
first, then selects it (`handleJumpToPaired` in `PlanGraphRoute.tsx`, carried
past the selection-reset effect by a pending-jump state); either way the canvas
recenters on it via a `centerRequest` token. The selected node id lives in
`PlanGraphRoute.tsx`, not the canvas, so the route's one Escape handler closes
the inspector first and the whole route only on a second press. Nodes are
`draggable: false` (a read-only, auto-laid-out graph); they click to inspect but
don't move.

The remaining legibility aids sit on the canvas itself:

- The **MiniMap** (bottom-right, toggled from the rail, and shown only while part
  of the graph is off screen) colors each node by the
  worst finding band on it (`planGraphMiniMapNodeColor`, `plan-graph-minimap.ts`),
  so the overview shows where the problems are; a node with no finding keeps the
  neutral plan color and the large group boxes recede into a muted fill.
- A **legend** panel (`PlanGraphLegend.tsx`, collapsed by default, toggled from the
  rail) keys the operator icons, the heat-bar colors, the shuffle-weighted edge
  thickness, and the segment-vs-stage box layers.
- When the category filter hides every operator in view, a **status hint**
  (top-center) names the count hidden and points at Settings, instead of
  leaving only empty group boxes on screen.

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
