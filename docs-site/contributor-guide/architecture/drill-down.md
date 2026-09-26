# Drill-down

`StageDetailProvider` (`src/view/StageDetailContext.tsx`) replaces the legacy
`openStageDetail` `window` `CustomEvent` with React context. Any component calls
`useStageDetail().openStage(stageId)` to open `StageDetailDialog.tsx`, a
Radix/shadcn `Dialog`, for that stage. The callers are StagePill, Timeline,
StageTable, and (indirectly, via an embedded `StageHeader`/`StagePill`)
Skew's per-stage rows.

The dialog is titled "Stage N", with Spark's stage name (the code line that
created the stage) as a labelled "Code location" description. Its body opens
with one sentence placing the stage in the run (duration, share of the run's
wall-clock, task count, how many finding types it carries), then lists each
finding type the way `RunVerdict` lists a step: tag and action label, the
`TAG_HELP` plain explanation, "What to try", the impact estimate, and a
**Show evidence** button. Types sort worst band first, then by potential
wall-clock savings, the verdict's own order. Show evidence closes the dialog
and calls the optional `onRoute` prop (`requestRoute` from `Dashboard.tsx`);
`finalFocus` skips returning focus to the opener in that case, so the route's
own focus on the evidence stands. Without `onRoute` the button is not shown.

The legacy `drillDownToStage` force-expand-and-`scrollIntoView` event has no
replacement. No code ever dispatched it, so it was dormant even before the
migration.

## Plan DOT serialization

`packages/core/src/plan-dot.ts` (entry `planTreeToDot(planTree, { title })`) serializes a
resolved `planTree` to a
Graphviz DOT string. It is dependency-free string building. A first pass walks
the tree assigning stable node ids and `label` (name, plus `detail` on a second
line when it differs). A second pass emits the parent→child edges once ids are
known. The graph is laid out `rankdir=BT`, leaves at the bottom, matching
Spark's own plan orientation.

It carries no metric annotation: pure structure. Adding metric annotation is a
deferred roadmap item. A null plan returns an empty string. There is no
download/export UI for this output anymore (removed); `PlanView.tsx` calls it
only to decide whether a stage's plan tree can render as a graph at all, and a
non-empty result gates the "View plan graph" button.

## Plan graph view

`buildPlanGraphModel(planTree, opts)` (`packages/core/src/plan-graph-model.ts`) flattens a
resolved `planTree` into a `{ nodes, edges, segmentIndex, segmentCount, scope,
segmentStageIds }` graph shape. `src/view/PlanGraphRoute.tsx` renders it with
`@xyflow/react` (React Flow, pan/zoom/viewport/MiniMap) and `@dagrejs/dagre`
(node layout, `src/view/plan-graph/dagre-layout.ts`, `rankdir: 'RL'`).

Every `PlanGraphEdge` points `source: parentId, target: id` (parent/consumer →
child/producer), and dagre places an edge's source at the higher-rank end. So
`RL`, rather than the more intuitive-looking `LR`, is what lands reads/scans
(targets, computed first) on the left and the final write/root (source) on the
right, matching the left-to-right reading order of the plan's data flow. Each
node's React Flow `Handle`s follow the same horizontal routing: `type="target"`
on `Position.Right` (its parent sits to the right) and `type="source"` on
`Position.Left` (its children sit to the left), rather than the top/bottom
anchors a vertical `TB`/`BT` layout would use.

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
duration share now (the write half no longer hard-codes to null):
`PlanGraphNode.tsx` only suppresses the displayed value for the read half,
since the read half occupies the exact tree position the original unsplit
node used to.

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
full-scope model *below* the guardrail threshold, rendering immediately with no
dialog and no `requestedScope` change. Since it's a permanent property of that
stage's plan (`buildPlanGraphModel` is deterministic per `(planTree, stageId,
appModel)`), there is no segment view left for that stage to switch back to. So
the toggle, still correctly labeled "Back to segment view" per `model?.scope`,
renders `disabled` rather than silently no-opping on click. Only the
explicit-expand path (`requestedScope === 'full'`) leaves it enabled.

The four Plan Advisor detectors (`duplicatePlanSubtree`, `smallFiles`,
`overBroadcast`, `underBroadcast`, in `packages/core/src/detectors.ts`) set
`Finding.planNodeIds`, an unambiguous pointer to the specific plan-tree
node(s) each finding is about (a whole subtree's root(s) for
`duplicatePlanSubtree`, the flagged scan/write node for `smallFiles`, the
join/broadcast node(s) for the broadcast pair). `buildPlanGraphModel`
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
graph. Every other finding type still has no plan-node pointer and renders
at the stage level only, via `Finding.stageId`/`Finding.stageIds`.

Plan-node ids are only unique within one SQL execution's tree, since
`resolvePlanTree` resets its `n0, n1, ...` id counter on every call (once
per SQL execution), so `buildPlanGraphModel` filters `findings` to
`finding.executionId === sqlExecutionId` (the execution the stage being
graphed belongs to) before indexing by node id. Without that filter, two
unrelated executions' trees can both contain a node named e.g. `n1`, and a
finding from one would badge onto the other's same-named node.

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
carries one finding chip (`PlanGraphFindingChip`) per finding on this stage,
but only when there's no outer stage box to carry them instead (i.e. only in
the default single-stage view). Each chip is a `TagBadge` (the ALL-CAPS tag)
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
this expanded view the outer stage box, not the nested segment box, carries the
stage's finding chips, since findings are stage-scoped rather than
segment-scoped. Each stage box shows only findings matched to its own stage
through `Finding.stageId` or `Finding.stageIds`; the default segment scope uses
the same matching for its displayed stage.

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
floats in its own corner. View is zoom in/out and fit (replacing React Flow's
`Controls`); Navigate is "Next worst duration" and "Next problem" (cycling to
the worst-share node and the worst-finding stage, via `setCenter`); Display is
the node-filter/duration Settings popover (`PlanGraphSettingsControl` with its
`iconOnly` rail variant, moved off the topbar), plus the legend and minimap
toggles. The rail renders inside `ReactFlowProvider` alongside `<ReactFlow>`, so
its `useReactFlow` zoom/center calls drive the same instance.

Clicking a node opens the **detail inspector** (`PlanGraphNodeDetail.tsx`), a
right-docked panel (not a floating card) that reflows the graph rather than
covering it. Each node box is a fixed size and truncates every field to one
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
- The **MiniMap** (bottom-right, toggled from the rail) colors each node by the
  worst finding band on it (`planGraphMiniMapNodeColor`, `plan-graph-minimap.ts`),
  so the overview shows where the problems are; a node with no finding keeps the
  neutral plan color and the large group boxes recede into a muted fill.
- The rail's legend toggle reveals a **legend** panel (`PlanGraphLegend.tsx`)
  keying the operator icons, the heat-bar colors, the shuffle-weighted edge
  thickness, and the segment-vs-stage box layers.
- When the category filter hides every operator in view, a **status hint**
  (top-center) names the count hidden and points at Settings, instead of
  leaving only empty group boxes on screen.

The view is reached via a "View plan graph" button in `PlanView.tsx`'s toolbar,
gated by the same `if (dot)` check described in "Plan DOT serialization" above.
It opens a `planGraph: { active, stageId }` Zustand slice
(`openPlanGraph`/`closePlanGraph`, `src/store/store.ts`) driving a top-level
`AppRoutes` branch in `src/App.tsx`, modeled directly on the existing
`comparison`/`RunComparisonRoute` full-takeover pattern.

`buildPlanGraphModel`'s output is memoized per `(activeFileId, stageId, scope)`
in `PlanGraphRoute.tsx`, since `stageId` alone isn't unique across loaded runs
and `applySnapshot` mutates `appModel` in place rather than replacing it (see
[State model](./state-and-history.md#state-model)). The memo cache is a
module-level `Map`, so it survives across route open/close: re-opening the same
stage in the same run reuses the cached model instead of rebuilding it. It must
still be evicted on a fresh parse or reload. `resetModel()` (`store.ts`) bumps a
`modelResetCount` counter for exactly this purpose, and `PlanGraphRoute.tsx`
subscribes to it to clear the cache. A counter rather than a direct call, since
`store.ts` has no view-layer imports anywhere else and importing a `.tsx` module
there would invert that dependency direction.

## Disclosure hierarchy

The Summary/Context/Details 3-tier framing (collapsed lead metric → expanded
widget body → per-stage `StageDetailDialog`) does not apply uniformly across the
28 registry widgets (`src/view/detector-registry.tsx`). 14 have a stage-anchored
Details tier reachable via `StagePill`/`StagePillGroup`: Skew, StageShape,
TinyTask (all split from TaskSkew), ShuffleIO, PartitionSizing (split from
ShuffleIO), Spill, GcPressure, StageFailed, TaskFailures, RetryWaste (split
from Failures), SlowHost, StageSlowness, Straggler, and SpeculationWaste
(split from ExecutorTimeline). The other 14 are app/sql-scope with no stage to
drill into, by design, so they stop at Summary/Context: MemoryUtilization,
ExecutorUtilization (split from the same widget as MemoryUtilization;
`utilization` is an app-wide average, no stage), JobFailures, ConfigAudit,
CacheUtilization, CoreUsageArea, AutoscalingChurn, CachingOpportunity (`scope:
'app'`, `stageId: null` on both its finding constructions, so it has no stage
to anchor to despite reading like a per-stage widget), IncompleteRun,
DuplicatePlanSubtree, SmallFiles, UnderBroadcast, OverBroadcast (all split
from PlanFindings, sql-scope, spanning multiple stages via `stageIds` rather
than one `stageId`), and ColdStart (split from ExecutorTimeline, but unlike
its four siblings above, app-scoped with no `stageId`).

## Reference panel

The topbar's "Reference" button and `DocsLink` (`src/view/DocsContext.tsx`) open
a shadcn `Sheet` (`src/view/DocsSheet.tsx`, mounted once inside
`DocsProvider`/`Dashboard.tsx`) that iframes a docs-site (VitePress) page,
built from the tuning reference under `packages/core/src/docs-content/`
(generated at build and test time, not committed, from the
`shuffle-works/spark-tuning-reference` commit pinned in its `upstream.json`;
`npm run docs:bump` moves the pin) and published as static HTML at `docs/tuning-reference/<page>.html`
(`docs-config.ts`'s `docsUrl()` resolves an anchor to that path plus a
`#<anchor>` fragment). `useDocs().open(anchor)` sets React state (`isOpen`,
`target`); Radix/Base UI's `Sheet` owns the slide-in animation, focus trap,
and outside-click/Escape dismissal. There is a single `DocsTarget` shape
(`{ kind: 'site', path }`): no vendor HTML and no `'vendor'` target kind, so
`DocsSheet` always drives the iframe the same way, reassigning `src` on any
path or theme change.

Most anchors the app links to are the page of the same name; a handful are
in-page fragments on another page instead (config-audit sub-findings and the
metric glossary live on the `config`/`metrics` pages; bottleneck sub-anchors
such as `bottleneck-stage-shape` live on the page of the bottleneck that owns
them, and two, `bottleneck-autoscaling-churn` and
`bottleneck-cache-utilization`, on the `cluster-config`/`memory-model`
chapters):
`docs-config.ts`'s `pageForAnchor()` is the one place that resolves an anchor
to its owning page. `npm run docs:build` (run automatically by `npm run
build`) generates `packages/core/src/docs-content/` from the pin if needed,
then renders it into
`docs-site/.vitepress/dist`, and `vite.config.ts`'s `copyDocsSite` plugin
copies that output to `dist/docs`; Vite's relative asset base keeps the app
and docs usable when `dist/` is deployed under a URL subpath.
`tests/doc-anchor-coverage.test.js` intersects `packages/core/src/docs-content/chapters/nav-index.json`
against every detector's `docAnchor` and warns (never fails) on dead links
(detector points at an anchor the nav index doesn't have) or orphaned
Detector Catalog anchors (no detector points at them); see
`scripts/doc-anchor-coverage.js`. The ported landing page
(`docs-site/tuning-reference/index.md`, the symptom-picker entry page) is
hand-authored, committed markdown, unlike the generated pages next to it.

A docs-site page has no channel back to this app: it's a plain static page
with no `postMessage` listener. `DocsSheet.tsx` reassigns the iframe's `src`
outright on any change to the resolved path or the theme, forcing a full
reload. Since re-assigning the exact same `src` string wouldn't make the
browser reload it, a `t=<theme>` marker is threaded into the query string
ahead of the `#anchor` hash purely to change the string and force a real
reload; the page never reads that param itself: it reads its light/dark
preference once, from the `vitepress-theme-appearance` localStorage key
`ThemeProvider` keeps current, the moment it boots.
