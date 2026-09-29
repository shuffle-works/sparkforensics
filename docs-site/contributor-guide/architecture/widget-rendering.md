# Widget rendering

## Render order (fixed, spec §5) {#widget-rendering-order-fixed-spec-§5}

`src/view/Dashboard.tsx`'s `FilteredBoard` renders inside a `<main>` that
opens with `SampleRunNotice` (only while the bundled sample run is open),
then `RunVerdict` (built from the unfiltered catalog), then a single
`Scorecard` strip, then `FindingFilterBar` (Advanced view, or any active
filter) and (only when an active filter empties both finding streams)
`NoMatchBanner`, then (when
the active filter doesn't empty the board) a two-tab `Tabs`
(`src/components/ui/tabs.tsx`, a base-ui primitive): **Findings** and
**Full app report** (2026-09-03 tabbed-impact-band-board redesign, replacing the
prior three stacked sections: All recommendations, Suggested Improvements,
Full app report, with a merged, impact-grouped Findings tab and an
always-reachable Full app report tab). Both `TabsContent` panels pass
`keepMounted`, so the inactive one is hidden (native `hidden` attribute)
rather than unmounted: switching tabs keeps each widget's local state (e.g.
ImpactBoard's expanded group) and scroll position.

`region` on `RegistryEntry` (`src/view/detector-registry.tsx`) is read again,
but only to decide whether a widget always mounts: `isAlwaysMountedType()`
flags the one `reference`-region type still carved out as an always-mounted
exception, `coreLocality` → `CoreUsageArea`. The other `reference`-region
types stay ordinary finding-gated instead: `cacheUtilization`,
`memoryUtilization`, and `utilization` are a product decision: a clean run
on any of them isn't evidence worth surfacing unconditionally, so each
collapses to a plain clean-check line like any other detector. The Findings
tab (`src/view/widgets/ImpactBoard.tsx`) groups its content into two
tiers: impact-banded rows and cards for every `REGISTRY` component and
every recommendation row with at least one finding; and a collapsed "Clean
checks" disclosure covering every remaining type with zero findings, built
per detector *type* (`Object.keys(REGISTRY)`). The one always-mounted
exception lives in Full app report (see "ReferenceSection" below), which
stays structural-only.

Tags carry their own docs links; there is no separate legend widget.
`TagBadge` (`src/view/ImpactBadge.tsx`) resolves its own tooltip. Its
documentation anchor is the caller's `docAnchor` prop when that is a known
anchor (call sites holding the finding pass `finding.docAnchor`; a widget
header or grouped row passes `sharedDocAnchor(findings)`), else the type's
single known anchor (the run interpretation's `detectors[type].docAnchor`, from
`docAnchorForType` in `packages/core/src/detector-docs.ts`). The
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
`plainBadge` prop suppresses both links together; Stage Summary's per-stage
tag chips are the one caller that sets it, on a chip that sits inside its
own investigate button. Findings-tab rows leave it unset, so their badge
links stay real `<a>`s. The HTML export renders no badge links at all
(`exportMode`).

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
list). The rollup and its ranking are computed in core by `interpretRun`
(`rankedRollup`/`rankFindings`, `packages/core/src/recommendation-rollup.ts`);
`useFixTheseFirstData` reads it through `boardRollup`
(`src/view/interpretation.ts`: the interpretation's carried groups when
unfiltered, core `rankedRollup` recomputed over the kept findings under a
filter). `ImpactBoard` then buckets rows by each group's `band` (its
representative member's impact band, after core `rankFindings`, the same
finding whose impact band its own badge already shows) and cards by each
active widget's own `worstImpactBand`.

Eligible findings for the rollup are `catalog` ∪ `configFindings` that pass
core `isEligible` (`packages/core/src/recommendation-rollup.ts`) and have a
display type (`FINDING_DISPLAY_ORDER`): `incompleteRun` (a
pipeline-completeness caveat, not an addressable fix; see the spec's
`fixEffort` table) and every `dataUnavailable` evidence caveat (e.g.
`memoryUtilization`'s `memoryBand` variant, already covered by Evidence
availability's own `executorMetrics` entry,
`packages/core/src/evidence-availability.ts`) are excluded. Findings are grouped strictly by `finding.type` via
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
A summary row's tag badge and action label come from the group's own
highest-impact member (via the same three-tier comparator, core
`rankFindings`); its sentence is the type-level
`coreFindingGenericRecommendation`, not one member's own numbers. The
trailing stat depends on the group's
kind (`×N · <time> recoverable`, `×N · <total>` with the summed resource
waste the CLI report also prints, or `×N` alone, adding a per-impact-band
tally only when the group mixes bands). Clicking it expands straight to the group's
full, impact-ranked list, with no intermediate "worst-K" step, paginated at
10 rows per page (`data-testid="fix-these-first-group-row"`; no pager renders
for a group of 10 or fewer findings; it appears once a group exceeds 10).
A band's rollup rows render as a headerless three-column `Table`
(`src/components/ui/table.tsx`): a single-finding row (`FindingRow`,
`data-testid="fix-these-first-row"`, `data-finding-type`) has three
`TableCell`s: the impact dot + ALL-CAPS tag as a real `TagBadge` (not
`plainBadge`: nothing wraps it, so its own docs links stay real `<a>`s,
same as everywhere else on the board); a text block inside its own nested
`<button>` (a short imperative action label, e.g. "Reduce shuffle size",
from `findingActionLabel` (`packages/core/src/finding-action-label.ts`), over the
finding's own full `recommendation` sentence in smaller muted text, both
wrapping rather than truncating); and a right-aligned monospace stage
reference + impact figure (e.g. `St.49 · 20.1s`, via the shared
`formatWallClockRange`/`formatRawWaste` in `packages/core/src/format-utils.ts`). That inner button, not the
row, is the click target: it routes via `selectTriageTargetForFinding`
(`src/view/triage-target.ts`), the same per-finding resolver Stage Summary
Table's own control uses (see "First investigation routing" below); a
`TypeGroupRow`'s own inner button toggles its expand state instead
(`aria-expanded`). An expanded group's members (`FindingInstanceRow`) omit
the badge and span its cell (`colSpan={2}`): the location line, then the
recommendation clamped to one line, then the figure in the third column.
`ImpactBoard` owns which single group is expanded (`expandedGroupKey`); a
`TypeGroupRow` owns only its page.

Each impact band (`ImpactBoard.tsx`'s own `ImpactGroup`, one call per
entry of `IMPACT_BAND_ORDER_LIST = ['critical', 'warning', 'info']`) is a
`<section aria-labelledby>` pointing at its
`<h2 id="impact-band-<band>-heading" tabIndex={-1}>` (Critical, Warning,
Info; the top bar's count chip focuses it), a sibling of the panel's
sr-only `<h2>Findings</h2>`, and renders nothing (not even the heading) when it has neither a
rollup row nor an active widget: a run with no critical findings has no
"Critical" heading or section at all. Inside a band, rollup rows render
first as the headerless `Table` described above, followed by that band's
active `REGISTRY` widget cards (`computeActiveWidgets`'s ranked list,
filtered to this impact band) in their own `WidgetGrid`: every one of
`orderedWidgets()`'s deduped `REGISTRY` components *except* the one
always-mounted one below, with at least one finding in `catalog` ∪
`configFindings`. Within a band, active widgets keep `orderedWidgets()`'s
own order: the interpretation's `DetectorInfo` sorted by region
(`action` first), then ascending detector `order`. In Basic
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

Below the impact bands, `Alerts.tsx`'s exported `CleanChecks` renders a
collapsed "Clean checks" disclosure
of `CleanCheckRow` lines (`src/view/widgets/CleanCheckRow.tsx`: the type's
tag chip and label, plus in Advanced view the threshold it was held to, the
interpretation's `detectors[type].thresholdSummary` from
`getThresholdSummary`, which states the detector's own numbers) built per
detector *type* (every `REGISTRY` key
except that one always-mounted key), under one "Every check below passed."
line and grouped by detector scope (Per-stage, App-level,
SQL plan, Config checks). Types the log could not check (an `isEvidenceCaveat`
finding of that type, every per-stage type when no stage finished, or the
run-span types `RUN_SPAN_CHECK_TYPES` on an `incompleteRun` log, the same
rule that keeps the verdict from calling the run clean) render first under
**Not checked on this log** as `CleanCheckRow status="notRun"`, drawn
neutral rather than clean green, after the interpretation's `coverage.gaps`
(`verdictGaps`) lines saying why
and naming the setting to turn on. A clean run lands `cacheUtilization`,
`memoryUtilization`, and `utilization` here too, same as any ordinary
action-region type. Caching Opportunities, Config Audit, and the four split
Plan Advisor widgets (Redundant Plan Subtree, Excessive Small Files, Missed
Broadcast Join, Oversized Broadcast Join) render through the ordinary
active/clean paths above (see
[Board widgets beyond the fixed six](./board-widgets.md#board-widgets-beyond-the-fixed-six)).
Core Usage by Locality (`coreLocality`, resolving to `CoreUsageArea`) is
not in the Findings tab at all: it mounts unconditionally from `appModel`
at the head of the Full app report's reference grid
(`alwaysMountedWidgets()`/`isAlwaysMountedType()`), carrying its own
impact-band indicator when a finding is active instead of collapsing to a
clean-check line on a clean run. A `coreLocality` finding still lists in
its impact band's recommendation rows, and its **Show evidence** switches
to the Full app report tab.

### Per-widget list sort mode

`src/view/impact-sort.ts` (`sumWallClockLow`, `hasSortableImpact`, `canToggleSort`,
`byImpactDesc`, `stageIdOf`, `byStageAsc`), `src/view/useSortMode.ts` and
`src/view/SortModeToggle.tsx` are a shared, opt-in set a Findings-tab active widget can use
to let its own expanded, multi-row list default to potential-savings order (`wallClock.low`
descending, the guaranteed-floor bound, not the optimistic `high`) instead of stage number.
Each of the widgets below gets its `sortMode` (`SortMode`, `'impact' | 'stage'`, default
`'impact'`) from `useSortMode`, which forces impact order at Basic density, and renders a
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
`stageIdOf`, the lowest stage id its finding touches).
It is a two-segment `ToggleGroup` (Impact / Stage; optional `stageLabel`, default "Stage",
which no caller overrides), wrapped in `AdvancedOnly`: stage number is the one axis every one of these widgets' items can be compared on, unlike the
impact/raw-metric order this pattern replaced (dropped: comparing findings by impact band
ranks them by how bad they are, not by how much fixing them would save, which is a worse
default now that a real potential-savings figure exists to sort by instead). A per-stage
detector's own `finding.stageId` is the sort key directly; a sql-scope finding that spans
several stages (`duplicatePlanSubtree`, `smallFiles`, `underBroadcast`, `overBroadcast`,
via `stageIds`) sorts by the lowest stage id it touches (`stageIdOf`). The toggle renders
only when `canToggleSort` holds: `hasSortableImpact` finds a wall-clock claim in the list,
there is more than one row, and the card is open; re-sorting a list with no wall-clock
claim would be a silent no-op. Both comparators return `0` when
neither side has a comparable value, so those items keep their prior relative order
(`Array.prototype.sort`'s stability) rather than being shuffled.
`FixTheseFirst`'s own expanded group list (see "Findings tab" above) already sorted
by impact before this pattern existed and does not use it; it has no stage-order toggle.

### Gold Standard row/expand contract

Every `REGISTRY` widget renders its content as N≥1 rows, using
`Skew.tsx` as the reference implementation. A widget's data shape
(chart, table, single app-scoped scalar) is never by itself a reason to
skip this: the four named exceptions below (one histogram toggle, three
partial exceptions) are the only ones. Any further
exception must get its own entry here, justified in the same PR that
introduces it.

- Tier A (universal): `WidgetCard` chrome, an impact-band left-border + dot,
  ALL-CAPS `TagBadge`s, a
  `SortModeToggle` when `canToggleSort` is true, a `finding-anchor` ref
  on any focusable/deep-linkable unit, and an early `null` return on an
empty catalog filter (except Core Usage by Locality, the one always-mounted
  widget that renders unconditionally from `appModel` via
  `alwaysMountedWidgets()`/`isAlwaysMountedType()` rather than
  early-returning on an empty catalog filter).
- Tier B (the row/expand pattern): a row's collapsed state shows its core
  metric(s), `ImpactEstimate`, any config-hint code snippet/list, and docs
  links, all unconditionally. Widgets that pass `WidgetCard`'s `fixFor`
  (`ColdStart.tsx`, `SlowHost.tsx`, `Straggler.tsx`, `GcPressure.tsx`,
  `Spill.tsx`, `StageFailed.tsx`, `ExecutorUtilization.tsx`,
  `CacheUtilization.tsx`, `CachingOpportunity.tsx`,
  `DuplicatePlanSubtree.tsx`) state each distinct
  `coreFindingGenericRecommendation` once above the body, so their rows show
  only the measurement. Other Tier B widgets still print a per-row
  recommendation (e.g. `SmallFiles.tsx`, `UnderBroadcast.tsx`,
  `OverBroadcast.tsx`, `StageSlowness.tsx`, `SpeculationWaste.tsx`,
  `PartitionSizing.tsx`, `TaskFailures.tsx`, `ConfigAudit.tsx`,
  `AutoscalingChurn.tsx`, `MemoryUtilization.tsx`).
  Confidence and evidence are unconditional too, since the 2026-09 redesign: `RowStatusCluster`
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
  statusBadge` (`WidgetCard.tsx`'s header) keeps it out of the collapsed
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
  adopting widget, not floating with the row's detail below.
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
widget's empty-findings/no-data states), `MemoryUtilization.tsx`'s widget
header (confidence + evidence, one marker, since `executorMetrics` is
widget-wide; `ExecutorUtilization.tsx`'s rows, split out of the same former
combined widget, carry neither), each of the four split Plan Advisor
widgets' (`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`, `UnderBroadcast.tsx`,
`OverBroadcast.tsx`) widget header (confidence + `sqlPlan` evidence, one
marker per widget now that each is its own finding-type, replacing the old
`PlanFindings.tsx` per-group heading; no per-row control), `ScalingSim.tsx`
(two call sites, evidence only), `CoreUsageArea.tsx`, `EfficiencyModel.tsx`
and `PlanView.tsx` (three call sites) (these last confidence-only;
all standalone rather than per-finding-row: a card-header
badge, a widget-level single marker, a plan-tree node/summary-row marker, or
an "unavailable data" message: the same component, same visual language,
regardless of where it sits); and, since `skew`/`straggler`/`gc` started
disclosing their own unvalidated noise-floor thresholds (confidence only,
per-row, no `evidenceKey` passed), `GcPressure.tsx`'s rows, `Straggler.tsx`'s
rows, `CachingOpportunity.tsx`'s rows (the `cachingOpportunity` detector
scales `confidence` per finding via `cachingReuseConfidence`, so the badge
sits next to each row rather than as a single caveat below
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

No toggle at all, unconditional content (the fix per row or once via
`fixFor`, see Tier B), same as before this redesign (unaffected either way,
since these widgets never carried confidence/evidence display in the first
place): `IncompleteRun.tsx`, `ShuffleIO.tsx`, `PartitionSizing.tsx`,
`StageFailed.tsx`, `TaskFailures.tsx`, `RetryWaste.tsx`, `ColdStart.tsx`,
`SlowHost.tsx`, `StageSlowness.tsx`, `SpeculationWaste.tsx`,
`ExecutorCountChart.tsx`, `ExecutorUtilization.tsx`, `JobFailures.tsx`,
`CacheUtilization.tsx` and `AutoscalingChurn.tsx`.

Three named exceptions to specific pieces of the contract, not to the row
wrapper or pagination, which still apply to all three:

- `CoreUsageArea.tsx`'s non-local-stage list is a derived stat breakdown
  (`computeCoreLocalityRatio`'s `topStages`), not a `Finding[]`: there is no
  per-row finding or recommendation to reveal. Paginated like every other
  Tier B list, but with no per-row expand.
- `CacheUtilization.tsx`'s RDD `<Table>` holds reference columns (name,
  storage level, partitions, memory, disk bytes) with no recommendation
  attached to any row. Paginated like every other Tier B list, but with no
  per-row expand. Its separate finding list below the table is full Tier B
  (unconditional, no toggle, per the paragraph above).
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
`Accordion`: selecting the tab is the disclosure; the panel stays mounted
but hidden while Findings is active (see "Render order" above). Its exact order is WallClock
→ Timeline → Executor Count Over Time (`ExecutorCountChart.tsx`, the
executor add/remove count chart extracted out of the former combined
`ExecutorTimeline.tsx`; not driven by any finding, so it isn't a
`REGISTRY` entry) → StageTable → a `WidgetGrid` holding Core
Usage by Locality (the one always-mounted `REGISTRY` card) → Evidence
availability → ETL Phase Attribution → What-If Executor Scaling →
Compute Efficiency → Core-Usage Distribution.
Scorecard used to lead this
section; it now renders once, above the tabs themselves, in
`FilteredBoard` (`src/view/Dashboard.tsx`), so it stays visible regardless
of which tab is active rather than living inside either one (a three-tile
run-info row: Wall-clock, Efficiency, Unused core time; see
[Board widgets beyond the fixed six](./board-widgets.md#board-widgets-beyond-the-fixed-six)).
WallClock, Timeline, Executor Count Over Time and StageTable render
expanded. The grid tiles beside them (Core Usage by Locality, Evidence
availability and the report lenses) are `collapsedTile`s: they start
collapsed at a uniform height and widen to the full row when opened;
`revealEvidence` opens the Evidence availability tile. Core Usage by Locality is the only detector-driven `REGISTRY`
card in this section, always mounted; Memory Utilization, Executor
Utilization, and Cache Storage live in the Findings tab above and surface
there only when they have an active finding.

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
walk the static `DETECTORS` import. The component-identity dedup it
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
own array order and iteration, plus its cross-detector `suppressedBy` logic
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
`widgetId`; its label comes from core `FINDING_PRESENTATION` (`findingName`)
and its title from the widget itself, not from runtime position or raw
detector type. Eligible targets
have a mapped, routeable registry entry and a non-empty trimmed
recommendation (`triageTargetFor`, `src/view/triage-target.ts`). The
target's widget still renders every affected stage in its local order.

`src/view/triage-target.ts` also exports `rankTriageTargets`, which orders
`catalog` by the run interpretation's `savingsRank`. That rank comes from
core's `rankBySavings` (`packages/core/src/run-verdict.ts`, shared with the
CLI/MCP verdict), which orders every routeable finding by potential savings
(`impactEstimate.wallClock.high`), a quantified estimate ahead of an
unquantified one, then impact band, then widget display order
(`FINDING_DISPLAY_ORDER`, core's copy of `orderedWidgets()`, which a
`tests/view/detector-registry.test.tsx` case keeps equal), then catalog order;
`selectTriageTarget` is its first entry. Ranking by potential savings replaced the earlier
severity-first routing once the occupancy-weighted impact estimator gave
every finding a real, comparable `impactEstimate.wallClock` figure:
severity-first could point a "start here" pick at a `skew`/`straggler`
finding ranked `critical` on a ratio basis while its occupancy-clipped
recoverable time was near zero, passing over a lower-severity finding with
an order-of-magnitude larger real recoverable-time estimate right next to
it. Impact band only breaks ties. `RunVerdict`'s next steps are built from
this ranking (see "Full render sequence" below).

The route is re-derived from the current catalog before each asynchronous
step. Its identity is object-reference equality against the current
catalog (`catalog.includes(finding)` in `selectTriageTargetForFinding`,
`src/view/triage-target.ts`) rather than a derived key: a new parse yields
new finding object references, so reference presence alone detects
staleness. It is not persisted and does not extend the core `Finding`
contract; cross-session consumers (exports, future URL-restored state) use
the core `Finding.id` instead (see [Finding identity](./worker-protocol.md#finding-identity)).

`Dashboard` owns disclosure and navigation. Every routeable `REGISTRY`
widget lives in the Findings tab except the always-mounted Core Usage by
Locality, which lives in Full app report (see "Render order" above), so
`requestRoute` (`DashboardContent`, `src/view/Dashboard.tsx`) starts by
switching to the tab holding the target's widget
(`isAlwaysMountedType(target.finding.type)` picks Full app report), whether
the request came from a control already on that tab or from the other. Both
panels stay mounted, but a route can still mount its target card fresh in
the same commit as the route landing: a Basic-view band's "Show the
evidence" fold mounts its cards only when opened, and opens itself when a
route targets one of them (see "Findings tab" above). Two routing paths
have to account for that: `reportWidgetOpen` no longer clears a
route just because the target `WidgetGridItem` hasn't registered yet in this
commit (a child `WidgetCard` reports its own open state before its parent
`WidgetGridItem`'s registration effect runs on a fresh mount, so treating
"not registered yet" as "stale" would drop the route before the parent even
gets a chance to register it); and a paginated widget that must reveal a
routed row passes its `routeIndex` into `usePagedRows`
(`src/view/usePagedRows.ts`), which computes the page
jump during render, not only in a post-commit effect, so the row exists in
the DOM in time for this same commit's anchor lookup instead of one commit
later.

After the target card commits open, an anchored row (`useFindingAnchor`) is
scrolled to center and focused, then flashed for 2 s; without one, the card
wrapper scrolls with a top margin below the fixed header and its disclosure
button receives visible, temporary route focus (using instant scrolling for
reduced motion). Requests use a latest-request-wins token (`tokenRef`,
`DashboardContent`) that guards every step and revalidates; a stale,
missing, unmounted, changed-catalog, or changed-active-file target cancels
without redirecting, scrolling, or moving focus. `registerWidget`'s cleanup
deletes a registration only if the map still holds that same object, so
StrictMode double-mounts don't drop a live one.

This route deliberately does not cover detector/parser or threshold
changes, Stage Detail routing, or generic
badges, tags, chips, or StagePills as controls. Config Audit findings route
like any other: they resolve against `catalog` ∪ `configFindings`.

### Widget placement

The Plan Explorer (`src/view/widgets/PlanExplorer.tsx`) is embedded inside a
flagged stage's own row, not as a standalone widget. It has four call
sites (`ShuffleIO.tsx`, `PartitionSizing.tsx`, `Spill.tsx`, and the shared
`StageFindingGroup.tsx` row behind `Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`),
each Advanced-density only and only when the stage's plan tree resolves.
The first three have no row-expansion toggle, so the trigger renders as a
direct sibling in the row body; `StageFindingGroup.tsx` renders it inside
the expanded Task detail. The same stage's plan is also reachable from `StageDetailDialog`.

Plan detection logic belongs in a `packages/core/src/detectors.ts` entry (`scope:'sql'`)
consuming `planTree`. `packages/core/src/plan-summary.ts` is display-only summarization; do
not add detection heuristics there. It is best-effort: `summarizePlanTree` reads each resolved
`planTree` node's `detail` with lenient regexes and silently omits a fragment it can't parse,
never surfacing an error.

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

Stage Summary Table (`src/view/widgets/StageTable.tsx`) defaults to the
**top 10 stages by duration**, with a header toggle to **problems only**
(stages carrying a finding). It
renders inside the Full app report tab, not as a standalone board section.

### Full render sequence

Top to bottom, in `Dashboard.tsx`'s `FilteredBoard`:

1. `SampleRunNotice` (`src/view/SampleRunNotice.tsx`), only while the
   bundled sample run is open (the landing's **Try a sample run** loads it
   under `SAMPLE_RUN_ID`, `src/view/sample-run.ts`) and never in the export
   bundle: says the board shows the sample, with **Load my event log** and a
   docs-panel link to the log-retrieval guide.
2. `RunVerdict` (`src/view/widgets/RunVerdict.tsx`): the run's verdict
   title, a summary sentence, and up to three numbered next steps built by
   `buildRunVerdict` (`packages/core/src/run-verdict.ts`, the same code the
   CLI/MCP evidence report's `verdict` runs) via `buildNextSteps`. Steps group routeable
   eligible findings by location (one stage, one multi-stage finding type,
   or one app-level finding type and variant), ordered by
   `rankBySavings` (potential savings, then impact band, then widget
   order), the same ranking every other component uses; on a run with a
   failed job, failure steps (`stageFailed`, `jobFailureRate`) move ahead
   (see below), and no other type jumps the order. Each step shows its tag,
   action label, stage and savings, then "What's happening:" (the
   measurement) and "What to try:" (the fix), split from the recommendation
   by core `recommendationParts`; a step that merged other types at its
   location adds "Also flagged here, likely the same cause: ...", and the
   summary says once that same-stage findings are grouped. Each step has
   **Show evidence**, **Stage N details** (when it has one stage) and
   **Copy**; "N more places under Findings" counts the places past the step limit.
   Basic view adds a collapsed "New to Spark tuning?" primer. An idle-capacity step (`utilization`, or
   `memoryUtilization`'s `idleCores` variant only, never its heap variants)
   titles the verdict only when it ranks first; otherwise an idle share of
   at least `IDLE_NOTABLE_PCT` (40%) adds one summary sentence. The
   idle share (`verdictIdlePct`) is the figure that idle-capacity step itself
   reports, falling back to the Scorecard's Unused core time figure only when no step
   carries one, so the title and the step never disagree. Each step's
   savings figure is followed by what it counts (`savingsMeaning` in
   `packages/core/src/impact-format.ts`: run time for a wall-clock figure, otherwise the
   resource its `rawWaste` unit measures), and **Copy next steps** copies the
   whole verdict as a plain-text checklist (`planCopyText` in core `run-verdict.ts`). Always the
   unfiltered catalog: a board filter never changes the verdict. A step's
   **Show evidence** on a finding the active filter hides clears only the
   filter dimensions that hide it (`excludingDimensions` in
   `src/view/finding-filter.ts`, synced to the URL as usual) and shows a
   one-line notice naming what it cleared; the Topbar count chip's jump to
   its impact band (`jumpToFindings` in `Dashboard.tsx`) uses the same path.
   The clean-run message ("No findings to fix right now.")
   lives here and shows only when no finding at all was emitted and the log
   lacked nothing a check needs (below); an
   `incompleteRun` finding always adds a sentence saying the figures cover
   only the captured part of the run, and titles the verdict ("This log
   looks incomplete ...") when no other finding is eligible. Job results
   (`summarizeRunOutcome` in `packages/core/src/run-outcome.ts`) set the run outcome:
   with a failed job the title says the run failed, the verdict quotes the
   first line of Spark's recorded reason (a failed job's `stageFailed`
   value first, then any `stageFailed`, then the job exception), the run is
   never called clean, and `buildNextSteps` ranks `stageFailed` and
   `jobFailureRate` steps first (a failed job's stage leading). Evidence
   caveats (a finding with `dataUnavailable`, or one `isRealFinding`
   drops), a log with no finished stage, and an `incompleteRun` log (whose
   `RUN_SPAN_CHECK_TYPES` had no run length to measure) are gaps
   (`verdictGaps`, `packages/core/src/check-coverage.ts`): any gap keeps the run from being called clean, and a
   log with no finished stage and no finding gets its own title. The
   verdict card does not list the gaps; the Clean checks disclosure's
   "Not checked on this log" group does, each caveat by its own
   recommendation text, which names the setting to enable. In Advanced view each step adds an
   "Estimate:" line from `estimateProvenance`
   (`packages/core/src/impact-format.ts`, carried as the interpretation's
   per-finding `savings.provenance`: method, basis as a point figure or a floor-to-high range, ms raw waste
   only when the floor clipped it, a non-time raw waste as the resource
   measured; nothing for `estimateMethod: 'none'` or a zero figure), the
   finding's `confidence` when not `high`, and the list ends with the
   ordering rule when it has more than one step.
3. `Scorecard`: a three-tile run-info row (Wall-clock, Efficiency, Unused
   core time; Basic view captions say what each measures, and for
   Efficiency and Unused core time which direction is better; Advanced view
   shows the raw run/idle breakdown),
   rendered once regardless of which tab is active.
4. `FindingFilterBar`, only in Advanced view or while a filter is active
   (plus `NoMatchBanner` when the active filter empties both finding
   streams).
5. A two-tab `Tabs` (skipped entirely when the active filter empties both
   finding streams; `NoMatchBanner` above already covers that case), tab
   labels **Findings** and **Full app report**:
   - **Findings** (`ImpactBoard`): one `<section>`
     per impact band in `Critical` → `Warning` → `Info` order, each rendering
     nothing when it has neither a recommendation row nor an active widget:
     a recommendation-rollup `Table` (one row per eligible-finding type,
     a display type, `incompleteRun` and evidence caveats excluded: a direct
     row for a type with one finding, an expandable, paginated summary row
     for a type with more than one) followed by a `WidgetGrid` of that
     band's active `REGISTRY` widgets (ranked by widget order: the
     interpretation's `DetectorInfo` by region, action-region components
     ahead of reference-region ones, then ascending detector order); then,
     below every impact band, a collapsed "Clean
     checks" disclosure of `CleanCheckRow` lines built per detector type
     (every remaining `REGISTRY` key with zero findings).
   - **Full app report** (`ReferenceSection`): WallClock → Timeline →
     Executor Count Over Time → StageTable → a grid of Core Usage by
     Locality → Evidence availability → fixed
     report-lens tail (ETL Phase Attribution → What-If Executor Scaling →
     Compute Efficiency → Core-Usage Distribution).
     Structural-only, as above. Hidden (not unmounted) while Findings is
     active (see "Render order" above).

Report lenses carry no impact-band chip and self-hide when their input data is
absent. Every widget self-wraps in `WidgetCard` (`src/view/WidgetCard.tsx`: an
`<h3>` title, one level below the board's `<h2>` section headers) for the
document outline, except Scorecard, which renders its own header band, and
RunVerdict, a plain `<section>` with its own `<h2>` title.

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
