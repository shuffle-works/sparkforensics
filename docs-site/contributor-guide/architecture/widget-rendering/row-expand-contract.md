# Gold Standard row/expand contract

The row and expand contract every widget in the registry follows.

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
  links, all unconditionally. The fix is stated once per card: `WidgetCard`'s
  `fixFor` prints each distinct `coreFindingGenericRecommendation` above the
  body, so rows don't repeat a recommendation that restates their number.
  Every finding-row widget passes it, Shuffle I/O and the Skew, Stage Shape
  and Tiny Tasks groups (`StageFindingGroup`) included; Incomplete Run is the
  one that doesn't.
  Where the detector's sentence is a row's only measurement (Excessive Small
  Files, Missed Broadcast Join, Oversized Broadcast Join, Config Audit), the
  row shows its measured half, split off by core's `recommendationParts`.
  Three rows keep their own sentence because their type has no generic fix
  for them: Incomplete Run, and a data-unavailable Memory Utilization or
  Cache Storage row, which names the setting to enable.
  Confidence and evidence are unconditional too: `RowStatusCluster`
  (`src/view/RowStatusCluster.tsx`) is a single, fixed-position pill
  combining both. Every widget that
  carries one wraps it in `AdvancedOnly` (`src/view/AdvancedOnly.tsx`), so it
  only renders at the Advanced density tier: this is a content-visibility
  gate (Basic vs. Advanced), not a per-row collapse, and it's applied
  consistently across every adopting widget. No widget gates confidence or
  evidence behind a per-row click. A
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
  `aria-label`, regardless of what else sits nearby. Clicking it calls
  `revealEvidence`.
  `RowStatusCluster`'s fixed slot is the row's own stage-pill/title line
  (`justify-between`, cluster right-aligned), the same position in every
  adopting widget, not floating with the row's detail below.
  Lists longer than `VISIBLE_LIMIT` (6, `packages/core/src/format-utils.ts`) get
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
widget-wide; `ExecutorUtilization.tsx`'s rows carry neither), each of the
six Plan Advisor widgets' (`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`,
`NestedLoopJoin.tsx`, `PythonUdf.tsx`, `UnderBroadcast.tsx`, `OverBroadcast.tsx`) widget header (confidence +
`sqlPlan` evidence, one marker per widget since each is its own finding
type; no per-row control), `ScalingSim.tsx`
(two call sites, evidence only), `CoreUsageArea.tsx`, `EfficiencyModel.tsx`
and `PlanView.tsx` (three call sites) (these last confidence-only;
all standalone rather than per-finding-row: a card-header
badge, a widget-level single marker, a plan-tree node/summary-row marker, or
an "unavailable data" message: the same component, same visual language,
regardless of where it sits); and, because `skew`/`straggler`/`gc`
disclose their own unvalidated noise-floor thresholds (confidence only,
per-row, no `evidenceKey` passed), `GcPressure.tsx`'s rows, `Straggler.tsx`'s
rows, `CachingOpportunity.tsx`'s rows (the `cachingOpportunity` detector
scales `confidence` per finding via `cachingReuseConfidence`, so the badge
sits next to each row rather than as a single caveat below
the table), and the shared `StageFindingGroup.tsx` row (adopted by
`Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`, though only `skew`
findings carry a `confidence` field).

One named exception:

- `Skew.tsx`/`StageShape.tsx`/`TinyTask.tsx`: their per-row histogram toggle
  (`ExpandToggleButton` + `useExpandableRow`) gates a lazily-fetched duration
  histogram, unrelated to confidence/evidence. It sits alongside
  `RowStatusCluster` in the shared `StageFindingGroup.tsx` row; the two
  controls coexist per row. `ExpandToggleButton` is single-purpose
  (always the task-detail toggle) since these three are its only adopters.

No toggle at all, unconditional content, since these widgets carry no
confidence/evidence display: `IncompleteRun.tsx`, `ShuffleIO.tsx`, `PartitionSizing.tsx`, `StageFailed.tsx`,
`TaskFailures.tsx`, `RetryWaste.tsx`, `ColdStart.tsx`, `SlowHost.tsx`,
`StageSlowness.tsx`, `SpeculationWaste.tsx`,
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
