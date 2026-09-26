# Widget rendering

## Render order (fixed, spec §5) {#widget-rendering-order-fixed-spec-§5}

`src/view/Dashboard.tsx`'s `FilteredBoard` renders inside a `<main>` that
opens with `RunVerdict` (built from the unfiltered catalog), then a single
`Scorecard` strip, then `FindingFilterBar` (Advanced view, or any active
filter) and (only when an active filter empties both finding streams)
`NoMatchBanner`, then (when
the active filter doesn't empty the board) a two-tab `Tabs`
(`src/components/ui/tabs.tsx`, a base-ui primitive): **Findings** and
**Full app report** (2026-09-03 tabbed-impact-band-board redesign, replacing the
prior three stacked sections: All recommendations, Suggested Improvements,
Full app report, with a merged, impact-grouped Findings tab and an
always-reachable Full app report tab). Base-ui `Tabs` fully unmount the
inactive `TabsContent` panel rather than hiding it: a widget mounted only in
Findings (every routeable `REGISTRY` widget; see "First investigation
routing" below) is not in the DOM at all while Full app report is active, and
remounts fresh, with its own state reset, when the user switches back.

`region` on `RegistryEntry` (`src/view/detector-registry.tsx`) is read again,
but only to decide whether a widget always mounts: `isAlwaysMountedType()`
flags the one `reference`-region type still carved out as an always-mounted
exception, `coreLocality` → `CoreUsageArea`. The other `reference`-region
types stay ordinary finding-gated instead: `cacheUtilization`,
`memoryUtilization`, and `utilization` are a product decision: a clean run
on any of them isn't evidence worth surfacing unconditionally, so each
collapses to a plain clean-check line like any other detector. The Findings
tab (`src/view/widgets/ImpactBoard.tsx`) groups its content into three
tiers, same as the retired Suggested Improvements section did, just
re-sliced by impact band instead of living as one flat active grid. The
three tiers: impact-banded rows and cards for every `REGISTRY` component and
every recommendation row with at least one finding; a small always-visible
grid holding just the one exception above (mounted unconditionally from
`appModel` regardless of finding state, below the impact bands); and a
collapsed "Clean checks" disclosure covering every remaining type with zero
findings, built per detector *type* (`Object.keys(REGISTRY)`). Full app
report stays structural-only (see "ReferenceSection" below).

Tags carry their own docs links; there is no separate legend widget.
`TagBadge` (`src/view/ImpactBadge.tsx`) resolves its own tooltip. Its
documentation anchor is the caller's `docAnchor` prop when that is a known
anchor (call sites holding the finding pass `finding.docAnchor`; a widget
header or grouped row passes `sharedDocAnchor(findings)`), else the type's
single known anchor (`docAnchorForType`, `src/view/finding-tag-help.ts`). The
prop matters for `configAudit`, whose four entries carry different anchors,
so the type lookup finds none. With an anchor, the pill itself links into
the docs panel, and (density `advanced` only) a second icon link opens that
tag's entry in `docs-site/user-guide/understanding-findings.md`
(`findingGuideUrl`, `packages/core/src/docs-site-config.ts`) in the same
in-app docs panel; its `target="_blank"` only applies to a modifier-click or
when no `DocsProvider` is mounted. When
a type has no vendor-doc anchor (e.g. `incompleteRun`), the pill links
straight to that same guide entry instead of rendering as inert text, and
the second icon link is skipped as redundant. Either way, a linked pill gets
a visible dotted underline, not just a hover tooltip. `TagBadge`'s
`plainBadge` prop suppresses both links together; a Findings-tab
recommendation row is the one place that never sets it (see below), since
its badge cell isn't nested inside a button.

### Findings tab

Rendered by `FilteredBoard`'s `TabsContent value="findings"`
(`src/view/widgets/ImpactBoard.tsx`). Merges what used to be
two stacked sections, All recommendations and Suggested Improvements, into
one impact-ranked board. The recommendation-rollup logic lives in
`src/view/widgets/FixTheseFirst.tsx` (kept as its own file and its own
directly-testable exports, but no longer rendered as a standalone page
section by `Dashboard.tsx`) and the active-widget logic lives in
`src/view/widgets/Alerts.tsx` (same: kept, no longer rendered standalone).
`ImpactBoard` calls `FixTheseFirst.tsx`'s exported `useFixTheseFirstData`
(eligible findings, rollup groups, the top triage target) and
`Alerts.tsx`'s exported `computeActiveWidgets` (the ranked active-`REGISTRY`
list) to get the exact same data these two retired sections used to render
independently, then regroups both by impact band via `groupImpactBand`
(`FixTheseFirst.tsx`: a rollup group's representative member's impact band,
the same finding whose impact band its own badge already shows) and each
active widget's own `worstImpactBand`.

Eligible findings for the rollup are `catalog` ∪ `configFindings`, filtered
to a `REGISTRY`-mapped type, with `incompleteRun` (a pipeline-completeness
caveat, not an addressable fix; see the spec's `fixEffort` table) and
`memoryUtilization`'s `memoryBand`/`dataUnavailable` variant (a
missing-evidence caveat already covered by Evidence availability's own
`executorMetrics` entry, `packages/core/src/evidence-availability.ts`) both explicitly
excluded. Findings are grouped strictly by `finding.type` via
`buildRecommendationRollup` (`packages/core/src/recommendation-rollup.ts`, further split
within a type by impact kind and, for `resource`, unit: never merged across
types); each resulting group becomes one row: a type with exactly one
finding renders that finding directly, a type with more than one collapses
into a summary row. Within an impact band, group order comes from
`buildRecommendationRollup`'s own sort: `time` groups (a real `wallClock`
claim) first, ranked among themselves by their union-capped
`recoverableMsHigh` descending; then `resource` groups (`rawWaste` but no
`wallClock`); then `count` groups (neither), both of the latter two ranked
by worst impact band, never by their incomparable raw magnitudes.
A summary row's tag and dot, plus its text, all come from the group's own
highest-impact member (via the same three-tier comparator, computed
locally in `FixTheseFirst.tsx`); the trailing stat depends on the group's
kind (`×N · <time> recoverable`, `×N · resource-cost projection`, or a
plain per-impact-band tally). Clicking it expands straight to the group's
full, impact-ranked list, with no intermediate "worst-K" step, paginated at
10 rows per page (`data-testid="fix-these-first-group-row"`; no pager renders
for a group of 10 or fewer findings; it appears once a group exceeds 10).
A band's rollup rows render as a headerless three-column `Table`
(`src/components/ui/table.tsx`): every individual row, whether shown
directly or inside an expanded group, is a `TableRow`
(`data-testid="fix-these-first-row"`, `data-finding-type`) with three
`TableCell`s: the impact dot + ALL-CAPS tag as a real `TagBadge` (not
`plainBadge`: nothing wraps it, so its own docs links stay real `<a>`s,
same as everywhere else on the board); a text block inside its own nested
`<button>` (a short imperative action label, e.g. "Reduce shuffle size",
from `findingActionLabel` (`src/view/finding-action-label.ts`), over the
finding's own full `recommendation` sentence in smaller muted text, both
wrapping rather than truncating); and a right-aligned monospace stage
reference + impact figure (e.g. `St.49 · 20.1s`, via `ImpactEstimate.tsx`'s
shared `formatWallClockRange`/`formatRawWaste`). That inner button, not the
row, is the click target: it routes via `selectTriageTargetForFinding`
(`src/view/triage-target.ts`), the same per-finding resolver Stage Summary
Table's own control uses (see "First investigation routing" below); a
`TypeGroupRow`'s own inner button toggles its expand state instead
(`aria-expanded`) and its expanded findings render as further `TableRow`s
indented one badge-cell notch to read as the group's sub-list.

Each impact band (`ImpactBoard.tsx`'s own `ImpactGroup`, one call per
entry of `IMPACT_BAND_ORDER_LIST = ['critical', 'warning', 'info']`) is a
`<section aria-label="Critical" | "Warning" | "Info">` with an `<h3>`
heading, and renders nothing (not even the heading) when it has neither a
rollup row nor an active widget: a run with no critical findings has no
"Critical" heading or section at all. Inside a band, rollup rows render
first as the headerless `Table` described above, followed by that band's
active `REGISTRY` widget cards (`computeActiveWidgets`'s ranked list,
filtered to this impact band) in their own `WidgetGrid`: every one of
`orderedWidgets()`'s deduped `REGISTRY` components *except* the one
always-mounted one below, with at least one finding in `catalog` ∪
`configFindings`. Within a band, active widgets keep `orderedWidgets()`'s
own `action`-region-first, ascending-`DETECTORS`-order tiebreak. In Basic
view a band with both rows and cards folds its `WidgetGrid` behind one
"Show the evidence (N cards)" disclosure, unmounted while closed; it opens
itself (and stays open) when the active route target
(`useActiveRouteTarget`) is one of its cards, and the card, mounting with
the route still pending, opens and scrolls itself through
`registerWidget`. A band with cards but no rows, and every band in
Advanced view, shows its grid directly.
`cacheUtilization`, `memoryUtilization`, and `utilization` are
`reference`-region types but aren't always-mounted exceptions, so a Cache
Storage, Memory Utilization, or Executor Utilization card with an active
finding surfaces in its own impact band like any other active widget.

Below the impact bands, `Alerts.tsx`'s exported
`AlwaysVisibleAndCleanChecks` (shared verbatim with the retired standalone
`Alerts` component) renders the same two tiers it always did, now living
outside the impact-band grouping entirely rather than as this section's
second and third tier: a small always-visible grid holding just Core Usage
by Locality (`coreLocality`, resolving to `CoreUsageArea`), mounted
unconditionally from `appModel` regardless of finding state
(`alwaysMountedWidgets()`/`isAlwaysMountedType()`), carrying its own
impact-band indicator when a finding is active instead of collapsing to a
clean-check line on a clean run; and a collapsed "Clean checks" disclosure
of `CleanCheckRow` lines (`src/view/widgets/CleanCheckRow.tsx`: label, the
threshold it was measured against via `getThresholdSummary`, and "No fix
needed.") built per detector *type* (every `REGISTRY` key except that one
always-mounted key): a clean run lands `cacheUtilization`,
`memoryUtilization`, and `utilization` here too, same as any ordinary
action-region type. Caching Opportunities, Config Audit, and the four split
Plan Advisor widgets (Redundant Plan Subtree, Excessive Small Files, Missed
Broadcast Join, Oversized Broadcast Join) render through the ordinary
active/clean paths above (see
[Board widgets beyond the fixed six](./board-widgets.md#board-widgets-beyond-the-fixed-six)).
One consequence of this always-visible grid sitting below every impact
band: a `critical`-band `coreLocality` finding still renders in that lower
grid, below the `info`-band widgets above it, a deliberate tradeoff the
spec accepted in exchange for never losing the widget on a clean run, not a
ranking bug.

### Per-widget list sort mode

`src/view/impact-sort.ts` (`sumWallClockLow`, `hasSortableImpact`, `byImpactDesc`,
`stageIdOf`, `minStageId`, `byStageAsc`) and `src/view/SortModeToggle.tsx` are a shared,
opt-in pair a Findings-tab active widget can use to let its own expanded, multi-row
list default to potential-savings order (`wallClock.low` descending, the guaranteed-floor
bound, not the optimistic `high`) instead of stage number. Each of the widgets below holds
local `sortMode` state (`SortMode`, `'impact' | 'stage'`, default `'impact'`) and renders a
`SortModeToggle` in the `WidgetCard` `badges` slot, so it sits on the title row itself
rather than floating in the body: a button alongside the widget's tag badges (a
`WidgetCard` header renders `badges` beside the title heading, never inside another
control). Every one of the former combined widgets' split single-type widgets carries the
same `canToggleSort` check its parent did, so the toggle only actually renders for a type
whose finding can carry a wall-clock estimate: `Skew.tsx`, `TinyTask.tsx` (`stageShape`'s
own rules never produce one, so `StageShape.tsx` carries the same check but it never
fires), `ShuffleIO.tsx` (narrowed to `shuffle`), `PartitionSizing.tsx`, `Spill.tsx`,
`GcPressure.tsx` (both its high-GC and low-GC sections, one shared toggle),
`RetryWaste.tsx` (its siblings `StageFailed.tsx`/`TaskFailures.tsx` carry the same check,
but `stageFailed`/`failures` are `estimateMethod: 'none'`, so it never fires there either),
`SlowHost.tsx`, `StageSlowness.tsx`, `Straggler.tsx`, `SpeculationWaste.tsx`,
`ColdStart.tsx` (five widgets now, one per type, each sorting only its own flat issue
list; the old cross-type "coldStart sinks to the bottom under By stage" note no longer
applies now that each type has its own single-type list), and `DuplicatePlanSubtree.tsx`/
`SmallFiles.tsx`/`UnderBroadcast.tsx`/`OverBroadcast.tsx` (each reorders its own list by
`stageIdOf`, the lowest stage id its finding touches; the old cross-type `minStageId`
group-ordering tiebreak no longer applies, since each type is its own widget now).
Its `alternateOrderLabel` prop is required and every caller passes "By stage": stage
number is the one axis every one of these widgets' items can be compared on, unlike the
impact/raw-metric order this pattern replaced (dropped: comparing findings by impact band
ranks them by how bad they are, not by how much fixing them would save, which is a worse
default now that a real potential-savings figure exists to sort by instead). A per-stage
detector's own `finding.stageId` is the sort key directly; a sql-scope finding that spans
several stages (`duplicatePlanSubtree`, `smallFiles`, `underBroadcast`, `overBroadcast`,
via `stageIds`) sorts by the lowest stage id it touches (`stageIdOf`). The toggle only
renders when `hasSortableImpact` finds at least one wall-clock claim in the list;
re-sorting a list with none would be a silent no-op. Both comparators return `0` when
neither side has a comparable value, so those items keep their prior relative order
(`Array.prototype.sort`'s stability) rather than being shuffled.
`FixTheseFirst`'s own expanded group list (see "Findings tab" above) already sorted
by impact before this pattern existed and does not use it; it has no stage-order toggle.

### Gold Standard row/expand contract

Every `REGISTRY` widget renders its content as N≥1 rows, using
`Skew.tsx` as the reference implementation. A widget's data shape
(chart, table, single app-scoped scalar) is never by itself a reason to
skip this: the three named exceptions below are the only ones. Any further
exception must get its own entry here, justified in the same PR that
introduces it.

- Tier A (universal): `WidgetCard` chrome, an impact-band left-border + dot,
  ALL-CAPS `TagBadge`s, a
  `SortModeToggle` when `hasSortableImpact` is true, a `finding-anchor` ref
  on any focusable/deep-linkable unit, and an early `null` return on an
empty catalog filter (except Core Usage by Locality, the one always-mounted
  widget that renders unconditionally from `appModel` via
  `alwaysMountedWidgets()`/`isAlwaysMountedType()` rather than
  early-returning on an empty catalog filter).
- Tier B (the row/expand pattern): a row's collapsed state shows its core
  metric(s), `ImpactEstimate`, its recommendation text, any config-hint code
  snippet/list, and docs links, all unconditionally. Confidence and evidence
  are unconditional too, since the 2026-09 redesign: `RowStatusCluster`
  (`src/view/RowStatusCluster.tsx`) is a single, fixed-position pill
  combining both, replacing the old per-row `ExpandToggleButton` +
  `ConfidenceMarker` + `EvidenceLink` trio entirely. Every widget that
  carries one wraps it in `AdvancedOnly` (`src/view/AdvancedOnly.tsx`), so it
  only renders at the Advanced density tier: this is a content-visibility
  gate (Basic vs. Advanced), not a per-row collapse, and it's applied
  consistently across every adopting widget. There is nothing left to gate
  behind a per-row click for confidence or evidence in any widget. A
  widget-header `RowStatusCluster` (passed as `WidgetCard`'s `statusBadge`
  prop) carries one further, unrelated gate on top of `AdvancedOnly`: `open &&
  statusBadge` (`WidgetCard.tsx:138,141`) keeps it out of the collapsed
  header, matching the comment on `statusBadge` itself ("kept separate so
  tag/impact badges stay visible in the collapsed summary while a
  `RowStatusCluster`-style ... marker doesn't"). This is the card's own
  expand/collapse, not a separate reveal-on-click built for the cluster, and it
  composes with density as an AND: a header cluster needs both Advanced tier
  and an expanded card. A row with
  neither renders no cluster at all (`RowStatusCluster` returns `null`).
  Confidence renders as plain, non-interactive text ("`{confidence}
  confidence`", no further suffix) with a `title` + `aria-describedby` tooltip
  carrying the full `validationRequired` detail: never itself a click
  target. Evidence renders as the cluster's one real click target: a button
  whose visible text is just the evidence label (e.g. "SQL plan") but whose
  accessible name always carries the "Evidence: ..." prefix via an explicit
  `aria-label`, regardless of what else sits nearby (the old `bare`
  prop/prefix distinction is gone: there's only one form now). Clicking it
  calls the same `revealEvidence` navigation the retired `EvidenceLink` used.
  `RowStatusCluster`'s fixed slot is the row's own stage-pill/title line
  (`justify-between`, cluster right-aligned), the same position in every
  adopting widget, not floating with the recommendation text below.
  Lists longer than `VISIBLE_LIMIT` (6, `packages/core/src/format-utils.ts`) still get
  page-based navigation (Previous/Next, `usePagedRows`/`RowPagination`,
  `src/view/usePagedRows.ts`/`src/view/RowPagination.tsx`) instead of
  rendering unconditionally: the one sanctioned cap mechanism across every
  Tier B widget. A Tier B widget whose rows are also triage-routable (wires
  `useFindingAnchor`) must pass its `routeIndex` (the routed finding's
  position in the paginated list) into `usePagedRows`, or a deep-linked route
  to a finding beyond the first page silently degrades to focusing the
  widget's disclosure title instead of the row.

The following widgets carry a `RowStatusCluster`, all Advanced-only:
`Spill.tsx` (confidence only), `ConfigAudit.tsx`'s widget-header control
(evidence only, a widget-wide constant rather than per-finding data, since
the evidence key doesn't vary per row; also the control shown in the
widget's empty-findings/no-data states), `MemoryUtilization.tsx`'s rows
(confidence + evidence together;
`ExecutorUtilization.tsx`'s rows, split out of the same former combined
widget, carry neither), each of the four split Plan Advisor widgets'
(`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`, `UnderBroadcast.tsx`,
`OverBroadcast.tsx`) per-row control (evidence only) plus their own
widget-header marker (confidence only, one marker per widget now that each
is its own finding-type, replacing the old `PlanFindings.tsx` per-group
heading), `CoreUsageArea.tsx`, `EfficiencyModel.tsx`, `PlanView.tsx` (three
call sites), `ScalingSim.tsx` (two call sites), and `WastedCoreHours.tsx`
(all confidence-only, standalone rather than per-finding-row: a card-header
badge, a widget-level single marker, a plan-tree node/summary-row marker, or
an "unavailable data" message: the same component, same visual language,
regardless of where it sits); and, since `skew`/`straggler`/`gc` started
disclosing their own unvalidated noise-floor thresholds (confidence only,
per-row, no `evidenceKey` passed), `GcPressure.tsx`'s rows, `Straggler.tsx`'s
rows, `CachingOpportunity.tsx`'s rows (the `cachingOpportunity` detector
scales `confidence` per finding via `cachingReuseConfidence`, so the badge
sits next to each row's recommendation rather than as a single caveat below
the table), and the shared `StageFindingGroup.tsx` row (adopted by
`Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`, though today only `skew`
findings actually carry a `confidence` field).

One named exception:

- `Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`: their per-row histogram toggle
  (`ExpandToggleButton` + `useExpandableRow`) gates a lazily-fetched duration
  histogram, unrelated to confidence/evidence, so it was untouched by the
  2026-09 redesign and untouched again when `RowStatusCluster` was later
  added alongside it in the shared `StageFindingGroup.tsx` row. The two
  controls coexist per row. `ExpandToggleButton` is now single-purpose
  (always the task-detail toggle) since these three (split out of the former
  combined `TaskSkew.tsx`) are its only remaining adopters.

No toggle at all, unconditional recommendation/content, same as before this
redesign (unaffected either way, since these widgets never carried
confidence/evidence display in the first place): `IncompleteRun.tsx`,
`ShuffleIO.tsx`, `PartitionSizing.tsx`, `StageFailed.tsx`,
`TaskFailures.tsx`, `RetryWaste.tsx`, `ColdStart.tsx`, `SlowHost.tsx`,
`StageSlowness.tsx`, `SpeculationWaste.tsx`,
`ExecutorCountChart.tsx`, `ExecutorUtilization.tsx`, `JobFailures.tsx`,
`CacheUtilization.tsx`, `AutoscalingChurn.tsx`, and the four split Plan
Advisor widgets (`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`,
`UnderBroadcast.tsx`, `OverBroadcast.tsx`), split out of, respectively, the
former combined `ExecutorTimeline.tsx`, `Failures.tsx`, and
`PlanFindings.tsx`, none of which carried a per-row toggle either.

Three named exceptions to specific pieces of the contract, not to the row
wrapper or pagination, which still apply to all three:

- `CoreUsageArea.tsx`'s non-local-stage list is a derived stat breakdown
  (`computeCoreLocalityRatio`'s `topStages`), not a `Finding[]`: there is no
  per-row finding or recommendation to reveal. Paginated like every other
  Tier B list, but with no per-row expand.
- `CacheUtilization.tsx`'s RDD `<Table>` holds reference columns (name,
  storage level, partitions, memory, disk bytes) with no recommendation
  attached to any row. Paginated like every other Tier B list, but with no
  per-row expand. Its separate recommendation list below the table is full
  Tier B (unconditional, no toggle, per the paragraph above).
- `IncompleteRun.tsx` leads with no metric of its own: this app-scoped,
  single-finding widget has no natural lead figure distinct from its
  title/badge, unlike every other Gold Standard widget, which leads with a
  percentage, duration, or count.

### ReferenceSection

Rendered by `FilteredBoard`'s `TabsContent value="full-report"`,
tab label "Full app report". A plain
`<div>`, structural-only, reading none of `REGISTRY`/`orderedWidgets()` at
all. Its heading is a visually-hidden (`sr-only`) `<h2>Full app
report</h2>`, matching the tab's own label for the accessibility-tree
heading outline without visually duplicating the tab text. No longer an
`Accordion`: base-ui `Tabs` unmount this panel entirely while Findings is
active (see "Render order" above), so there is no "collapsed but
present" state left to model, and this content is simply not in the DOM
until the user clicks the Full app report tab. Its exact order is WallClock
→ Timeline → Executor Count Over Time (`ExecutorCountChart.tsx`, the
executor add/remove count chart extracted out of the former combined
`ExecutorTimeline.tsx`; not driven by any finding, so it isn't a
`REGISTRY` entry) → StageTable → a `WidgetGrid` holding Evidence
availability → ETL Phase Attribution → What-If Executor Scaling →
Compute Efficiency → Wasted Core-Hours → Core-Usage Distribution.
Scorecard used to lead this
section; it now renders once, above the tabs themselves, in
`FilteredBoard` (`src/view/Dashboard.tsx`), so it stays visible regardless
of which tab is active rather than living inside either one (a three-tile
run-info row: Wall-clock, Efficiency, Unused core time; see
[Board widgets beyond the fixed six](./board-widgets.md#board-widgets-beyond-the-fixed-six)).
WallClock, Timeline, StageTable and every tile in the grid beside them
(Evidence availability included) all render immediately and fully
expanded. No detector-driven `REGISTRY` card renders in this
section any more: Memory Utilization, Executor Utilization, Core Usage by
Locality, and Cache Storage all moved to the Findings tab above (Cache
Storage, Memory Utilization, and Executor Utilization only surface there
when they have an active finding; Core Usage by Locality alone is
always-mounted).

The Evidence availability card is the persistent, non-impact-band ledger
[defined in the worker protocol](./worker-protocol.md#evidence-availability-contract-v1),
not an alert or detector widget. An `Evidence: …`
control appears only where a conclusion or unavailable report lens declares
a relevant ledger dependency. `revealEvidence`
(`src/view/EvidenceAvailabilityContext.tsx`) sets `referenceOpen` true,
which `DashboardContent` (`src/view/Dashboard.tsx`) watches in a `useEffect`
and translates into `setActiveTab('full-report')`, replacing what used to
be "expand the Reference accordion": mouse and keyboard activation switches
to the Full app report tab, opens the ledger card, then focuses the
referenced stable entry id (`evidence-availability-<key>`). The control
explains evidence availability; it does not promise an unavailable signal
would have produced a finding.

`WidgetGrid` (both inside a Findings impact band and inside
`ReferenceSection`): collapsed cards occupy one responsive column; opening a
card expands it across the full row. Nested `WidgetCard`s are isolated from
the parent grid state. A Findings-tab `FixTheseFirst` rollup row is a table
row, not a `WidgetGrid` card, and carries no collapse/expand state of its own
(a `TypeGroupRow` summary row does own its own local expand/pagination
state). Full app report's non-`REGISTRY` tiles (ETL Phase Attribution,
What-If Executor Scaling, Compute Efficiency, Wasted Core-Hours, Core-Usage
Distribution) sit in their own `WidgetGrid` alongside Evidence availability,
but that grid has no `widgetId` wired to any card (see "First investigation
routing" below), so nothing there is ever a route destination.

Firm constraint: `orderedWidgets()` (in `src/view/detector-registry.tsx`)
still runs the single `DETECTORS`-ascending sort exactly as
`dashboard-renderer.js` used to, and still sorts `action` components ahead
of `reference` ones within that one list; the component-identity dedup it
used to need is gone now that every `REGISTRY` entry maps to its own unique
component (2026-09 widget/finding-type 1:1 mapping redesign).
`cacheUtilization`, `memoryUtilization`, and `utilization` (`reference`-region)
can still reach the active grid alongside `duplicatePlanSubtree`
(`action`-region) and any other active finding, since none of them is the
one always-mounted exception filtered out before that grid.
`computeActiveWidgets` (`Alerts.tsx`) is still its main consumer, now filtered
through `isAlwaysMountedType()` to exclude that one always-mounted component;
the clean-check list bypasses `orderedWidgets()` entirely, iterating
`Object.keys(REGISTRY)` per type instead (see "Findings tab" above). `DETECTORS`'
own array order and iteration, plus its cross-detector `suppressWhen` logic
(e.g. `stageSlowness` deferring to `slowHost`, see
[Detector contract](./detector-contract.md#detector-contract)), live entirely in
`packages/core/src/detectors.ts`/`packages/core/src/analyzer.ts`, untouched by this redesign. Which React
component each finding type resolves to is still registry-owned.

### First investigation routing

The dashboard has a view-only per-finding route, not a single
first-investigation pick any more: every Findings-tab recommendation row
(rendered by `FixTheseFirst.tsx`'s row components inside `ImpactBoard`)
and the visible-finding control in Stage Summary (`StageTable.tsx`) each
independently resolve and request their own target.
`detector-registry.tsx` owns each routeable finding type's stable
`widgetId`, widget title, and finding label; identity and copy come from
there, not from runtime position or raw detector type. Eligible targets
have a mapped, routeable registry entry and a non-empty trimmed
recommendation (`targetForFinding`, `src/view/triage-target.ts`). The
target's widget still renders every affected stage in its local order.

`src/view/triage-target.ts` also exports `rankTriageTargets`, which orders
every routeable finding by potential savings (`impactEstimate.wallClock.high`),
a quantified estimate ahead of an unquantified one, then impact band, then
`orderedWidgets()` widget order, then catalog order; `selectTriageTarget`
is its first entry. Ranking by potential savings replaced the earlier
severity-first routing once the occupancy-weighted impact estimator gave
every finding a real, comparable `impactEstimate.wallClock` figure:
severity-first could point a "start here" pick at a `skew`/`straggler`
finding ranked `critical` on a ratio basis while its occupancy-clipped
recoverable time was near zero, passing over a lower-severity finding with
an order-of-magnitude larger real recoverable-time estimate right next to
it. Impact band only breaks ties. `RunVerdict`'s next steps are built from
this ranking (see "Full render sequence" above).

The route is re-derived from the current catalog before each asynchronous
step. Its identity is object-reference equality against the current
catalog (`catalog.includes(finding)` in `selectTriageTargetForFinding`,
`src/view/triage-target.ts`) rather than a derived key: a new parse yields
new finding object references, so reference presence alone detects
staleness. It is not persisted and does not extend the core `Finding`
contract; cross-session consumers (exports, future URL-restored state) use
the core `Finding.id` instead (see [Finding identity](./worker-protocol.md#finding-identity)).

`Dashboard` owns disclosure and navigation. Every routeable `REGISTRY`
widget now lives in the Findings tab (no `REGISTRY` widget renders inside
Full app report any more; see "Render order" above), so
`requestRoute` (`DashboardContent`, `src/view/Dashboard.tsx`) starts with an
unconditional `setActiveTab('findings')`, whether the request came from a
control already on that tab or from Full app report's own Stage Summary
route link. That tab switch can unmount and remount the whole Findings
subtree in the same commit as the route landing (base-ui `Tabs` fully
unmounts the inactive panel; see "Render order" above), which two
routing paths have to account for: `reportWidgetOpen` no longer clears a
route just because the target `WidgetGridItem` hasn't registered yet in this
commit (a child `WidgetCard` reports its own open state before its parent
`WidgetGridItem`'s registration effect runs on a fresh mount, so treating
"not registered yet" as "stale" would drop the route before the parent even
gets a chance to register it); and a paginated widget that jumps its own
page to reveal a routed row (`GcPressure.tsx`, `StageFailed.tsx`,
`TaskFailures.tsx`, `RetryWaste.tsx`) computes that
jump during render, not only in a post-commit effect, so the row exists in
the DOM in time for this same commit's anchor lookup instead of one commit
later.

After the target card commits open, its wrapper scrolls with a top margin
below the fixed header and its disclosure button receives visible, temporary
route focus (using instant scrolling for reduced motion). Requests use a
latest-request-wins token (`requestTokenRef`) that guards every step and
revalidates; a stale, missing, unmounted, changed-catalog, or
changed-active-file target cancels without redirecting, scrolling, or moving
focus. Widget registration probes survive StrictMode double-mounts via an
`unregistrationCheck` that re-validates before clearing.

This route deliberately does not include Config Audit, detector/parser or
threshold changes, Stage Detail routing, or generic badges, tags, chips, or
StagePills as controls.

### Widget placement

The Plan Explorer (`src/view/widgets/PlanExplorer.tsx`) is embedded inside a
flagged stage's own row, not as a standalone widget. Neither Task Skew nor
Spill embed it any more: both dropped their own `PlanExplorer` trigger
entirely (not merely re-gated behind a toggle), since the same stage's plan
is already reachable, unconditionally, from `StageDetailDialog`. Shuffle I/O
is `PlanExplorer`'s only remaining call site: it has no row-expansion toggle
of its own, so its trigger renders as a direct sibling in the row body.

Plan detection logic belongs in a `packages/core/src/detectors.ts` entry (`scope:'sql'`)
consuming `planTree`. `packages/core/src/plan-summary.ts` is display-only summarization; do
not add detection heuristics there.

`StageHeader.tsx` (`StagePill` plus a `<span>` naming the stage) vs. bare
`StagePill`/`StagePillGroup` is a deliberate row-density choice, not an
inconsistency: `StageHeader` is for single-stage-per-row detail widgets where
naming the stage adds context (`SlowHost.tsx`, `StageSlowness.tsx`,
`Straggler.tsx`, `SpeculationWaste.tsx`, `GcPressure.tsx`, `Skew.tsx`,
`StageShape.tsx`, `TinyTask.tsx`, `PartitionSizing.tsx`), while bare
`StagePill`/`StagePillGroup` is for compact, multi-row lists where many
stages appear per widget (`StageFailed.tsx`, `TaskFailures.tsx`,
`RetryWaste.tsx`, the four split Plan Advisor widgets, `Spill.tsx`, and
`StageTable.tsx`). `ShuffleIO.tsx` uses both in different parts of its own
row, which is fine: it isn't a violation of the convention above.

Stage Summary Table (`src/view/widgets/StageTable.tsx`) defaults to
**problem stages**, with a header toggle to **top 10 by duration**. It
renders inside the Full app report tab, not as a standalone board section.

### Full render sequence

Top to bottom, in `Dashboard.tsx`'s `FilteredBoard`:

1. `RunVerdict` (`src/view/widgets/RunVerdict.tsx`): the run's verdict
   title, a summary sentence, and up to three numbered next steps built by
   `buildNextSteps` (`src/view/run-verdict.ts`). Steps group routeable
   eligible findings by location (one stage, one multi-stage finding type,
   or one app-level finding type and variant), ordered by
   `rankTriageTargets` (potential savings, then impact band, then widget
   order); `prioritizeIdleCapacity` moves an idle-capacity step
   (`utilization`, or `memoryUtilization`'s `idleCores` variant only, never
   its heap variants) first when the idle share is at least 70%, or at
   least 40% while the best time-based fix is under 5% of wall-clock. The
   idle share (`verdictIdlePct`) is the figure that idle-capacity step itself
   reports, falling back to the Scorecard's Unused core time figure only when no step
   carries one, so the title and the step never disagree. Always the
   unfiltered catalog: a board filter never changes the verdict. A step's
   **Show evidence** on a finding the active filter hides clears only the
   filter dimensions that hide it (`excludingDimensions` in
   `src/view/finding-filter.ts`, synced to the URL as usual) and shows a
   one-line notice naming what it cleared; the Topbar count chip's jump to
   its impact band (`jumpToFindings` in `Dashboard.tsx`) uses the same path.
   The clean-run message ("No findings to fix right now.")
   lives here and shows only when no finding at all was emitted and nothing
   is listed under "Not checked on this log" (below); an
   `incompleteRun` finding gets its own non-clean title and a sentence
   saying the figures cover only the captured part of the run. Job results
   (`summarizeRunOutcome` in `src/view/run-outcome.ts`) set the run outcome:
   with a failed job the title says the run failed, the verdict quotes the
   first line of Spark's recorded reason (a failed job's `stageFailed`
   value first, then any `stageFailed`, then the job exception), the run is
   never called clean, and `buildNextSteps` ranks `stageFailed` and
   `jobFailureRate` steps first (a failed job's stage leading) while
   `prioritizeIdleCapacity` is skipped. Evidence caveats (a finding with
   `dataUnavailable`, or one `isRealFinding` drops) and a log with no
   finished stage are listed under "Not checked on this log", each caveat by
   its own recommendation text, which names the setting to enable; any gap
   keeps the run from being called clean, and a log with no finished stage
   and no finding gets its own title.
2. `Scorecard`: a three-tile run-info row (Wall-clock, Efficiency, Unused
   core time; Basic view captions say what each measures and which direction
   is better, Advanced view shows the raw run/idle breakdown),
   rendered once regardless of which tab is active.
3. `FindingFilterBar`, only in Advanced view or while a filter is active
   (plus `NoMatchBanner` when the active filter empties both finding
   streams).
4. A two-tab `Tabs` (skipped entirely when the active filter empties both
   finding streams; `NoMatchBanner` above already covers that case), tab
   labels **Findings** and **Full app report**:
   - **Findings** (`ImpactBoard`): one `<section>`
     per impact band in `Critical` → `Warning` → `Info` order, each rendering
     nothing when it has neither a recommendation row nor an active widget:
     a recommendation-rollup `Table` (one row per eligible-finding type,
     `REGISTRY`-mapped, `incompleteRun` excluded: a direct row for a type
     with one finding, an expandable, paginated summary row for a type with
     more than one) followed by a `WidgetGrid` of that band's active
     `REGISTRY` widgets (ranked by widget order: ascending `DETECTORS`
     order, action-region components ahead of reference-region ones); then,
     below every impact band, a small always-visible grid of just Core Usage
     by Locality, mounted unconditionally regardless of finding state, and a
     collapsed "Clean
     checks" disclosure of `CleanCheckRow` lines built per detector type
     (every remaining `REGISTRY` key with zero findings).
   - **Full app report** (`ReferenceSection`): WallClock → Timeline →
     Executor Count Over Time → StageTable → Evidence availability → fixed
     report-lens tail (ETL Phase Attribution → What-If Executor Scaling →
     Compute Efficiency → Wasted Core-Hours → Core-Usage Distribution).
     Structural-only, as above. Fully unmounted while Findings is active
     (see "Render order" above).

Report lenses carry no impact-band chip and self-hide when their input data is
absent. Every widget self-wraps in `WidgetCard` (`src/view/WidgetCard.tsx`: an
`<h3>` title, one level below the board's `<h2>` section headers) for the
document outline, except Scorecard, which renders its own header band.

Every card is collapsible: the title sits in a `CollapsibleTrigger` button
with a chevron (`WidgetCard.tsx`), and each widget sets its own
`defaultCollapsed` (most default to `true`; `ImpactBoard`'s action-region grid
forces `defaultCollapsed` on every `REGISTRY` widget instance it mounts, so a
marginal finding doesn't default open). Route navigation ("jump to this
finding") goes through the grid coordinator instead of a fixed `tabIndex`:
`WidgetGrid.tsx` tracks each card's disclosure button and bumps
`openRequestGeneration` to force a collapsed card open and focus its trigger
when the target finding has no anchored row of its own. How much a card shows
beyond that is a board-wide choice, set by the Basic/Advanced density tier in
the topbar.
