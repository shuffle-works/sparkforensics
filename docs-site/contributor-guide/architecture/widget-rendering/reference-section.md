# ReferenceSection

How the Full app report tab renders its reference widgets.

Rendered by `FilteredBoard`'s `TabsContent value="full-report"`,
tab label "Full app report". A plain
`<div>`, structural-only, reading none of `REGISTRY`/`orderedWidgets()` at
all. Its heading is a visually-hidden (`sr-only`) `<h2>Full app
report</h2>`, matching the tab's own label for the accessibility-tree
heading outline without visually duplicating the tab text. Selecting the
tab is the disclosure; the panel stays mounted
but hidden while Findings is active (see "Render order" above). Its exact order is WallClock
→ Timeline → Executor Count Over Time (`ExecutorCountChart.tsx`, the
executor add/remove count chart; not driven by any finding, so it isn't a
`REGISTRY` entry) → StageTable → a `WidgetGrid` holding Core
Usage by Locality (the one always-mounted `REGISTRY` card) → Evidence
availability → ETL Phase Attribution → What-If Executor Scaling →
Compute Efficiency → Core-Usage Distribution.
Scorecard is not part of this
section; it renders once, above the tabs themselves, in
`FilteredBoard` (`src/view/Dashboard.tsx`), so it stays visible regardless
of which tab is active rather than living inside either one (a three-tile
run-info row: Wall-clock, Efficiency, Unused core time; see
[App- and plan-level widgets](../board-widgets.md#board-widgets-app-and-plan-widgets)).
WallClock, Timeline, Executor Count Over Time and StageTable render
expanded. The grid tiles beside them (Core Usage by Locality, Evidence
availability and the report lenses) are `collapsedTile`s: they start
collapsed at a uniform height and widen to the full row when opened;
`revealEvidence` opens the Evidence availability tile. Core Usage by Locality is the only detector-driven `REGISTRY`
card in this section, always mounted; Memory Utilization, Executor
Utilization, and Cache Storage live in the Findings tab above and surface
there only when they have an active finding.

The Evidence availability card is the persistent, non-impact-band ledger
[defined in the worker protocol](../worker-protocol/evidence-availability.md#evidence-availability-contract),
not an alert or detector widget. An `Evidence: …`
control appears only where a conclusion or unavailable report lens declares
a relevant ledger dependency. `revealEvidence`
(`src/view/EvidenceAvailabilityContext.tsx`) bumps a `revealRequest`
counter, which `DashboardContent` (`src/view/Dashboard.tsx`) watches in a
`useLayoutEffect` and translates into `setActiveTab('full-report')`. Each
click is a new request, so it switches tabs again after the reader returns
to Findings. The layout effect makes the tab visible before the provider's
queued focus runs, since a row inside the hidden, still-mounted panel can't
take focus. Mouse and keyboard activation switches to the Full app report
tab, opens the ledger card, then focuses the referenced stable entry id
(`evidence-availability-<key>`). The control
explains evidence availability; it does not promise an unavailable signal
would have produced a finding.

`WidgetGrid` (both inside a Findings impact band and inside
`ReferenceSection`): collapsed cards occupy one responsive column; opening a
card expands it across the full row. Nested `WidgetCard`s are isolated from
the parent grid state. A Findings-tab `FixTheseFirst` rollup row is a table
row, not a `WidgetGrid` card, and carries no collapse/expand state of its own
(`ImpactBoard` holds which group is expanded; a `TypeGroupRow` owns only its
page). Full app report's non-`REGISTRY` tiles (ETL Phase Attribution,
What-If Executor Scaling, Compute Efficiency, Core-Usage
Distribution) sit in the same `WidgetGrid` as Core Usage by Locality and
Evidence availability; only Core Usage by Locality's item carries a
`widgetId` (see "First investigation routing" below), so it is the grid's
one route destination.

Firm constraint: `orderedWidgets(detectors)` (in `src/view/detector-registry.tsx`)
sorts the run interpretation's per-type `DetectorInfo` entries by region
(`action` before `reference`), then ascending detector `order`; it does not
walk the static `DETECTORS` import. Every `REGISTRY` entry maps to its own
unique component, so it needs no component-identity dedup.
`cacheUtilization`, `memoryUtilization`, and `utilization` (`reference`-region)
can reach the active grid alongside `duplicatePlanSubtree`
(`action`-region) and any other active finding, since none of them is the
one always-mounted exception filtered out before that grid.
`computeActiveWidgets` (`Alerts.tsx`) is its main consumer, filtered
through `isAlwaysMountedType()` to exclude that one always-mounted component;
the clean-check list bypasses `orderedWidgets()` entirely, iterating
`Object.keys(REGISTRY)` per type instead (see "Findings tab" above). `DETECTORS`'
own array order and iteration, plus its cross-detector `suppressedBy` logic
(e.g. `stageSlowness` deferring to `slowHost`, see
[Detector contract](../detector-contract.md#detector-contract)), live entirely in
`packages/core/src/detectors.ts`/`packages/core/src/analyzer.ts`. Which React
component each finding type resolves to is registry-owned.
