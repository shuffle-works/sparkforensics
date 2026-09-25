# Board widgets

## Beyond the fixed six {#board-widgets-beyond-the-fixed-six}

(Components below live in `src/view/widgets/`, one file per widget name,
e.g. `JobFailures.tsx`, `MemoryUtilization.tsx`.)

Six extra cards render in the Findings tab's active grid alongside the fixed
spec §5 six: Incomplete Run, Job Failures, Caching Opportunities, Config Audit,
Plan Advisor, and Autoscaling Churn, all `region: 'action'` in
`detector-registry.tsx`:

- **Incomplete Run** (tag `INCMP`, `IncompleteRun.tsx`): app-level "the
  capture never finished" caveat (DETECTORS entry `incompleteRun`). Fires
  whenever `app.startTime` was observed but `app.endTime` was not, i.e. no
  `SparkListenerApplicationEnd` in the log: an in-flight job, a rotated-away
  log, or a capture cut short. Order 5, ahead of every other detector, so its
  card is first among the Findings tab's `action`-region active widgets when
  present. The Findings tab's recommendation rollup (rendered by `FixTheseFirst.tsx`)
  excludes `incompleteRun` from that list outright (see
  [Widget rendering order](./widget-rendering.md#widget-rendering-order-fixed-spec-§5)):
  it's a pipeline-completeness caveat, not an addressable fix, so it never
  competes with other findings for a ranked slot there. Self-gates to `null`
  (no card in the DOM) once the run completed normally. Unrelated to
  `evidence-availability.ts`'s own
  `trustworthy` gate (see
  [Evidence-availability contract](./worker-protocol.md#evidence-availability-contract-v1)):
  that ledger only downgrades *absence* conclusions for individual evidence
  categories, never becomes a `DETECTORS` finding itself, and this card does
  not read it. No `docAnchor` is set: this is a tool-specific signal with no
  upstream `spark-tuning-reference` section.
- **Job Failures** (tag `JOBS`): app-level job-failure-rate rollup
  (DETECTORS entry `jobFailureRate` in `packages/core/src/detectors.ts`), computed from
  `app.jobs` (`SparkListenerJobEnd` results):
  ≥10% info, ≥30% warning, ≥50% critical. Complements the per-stage,
  task-level Failed Tasks card (tag `FAIL`).
- **Caching Opportunities** (tag `CACHE`, `CachingOpportunity.tsx`):
  app-level SQL relation-reuse detector (DETECTORS entry `cachingOpportunity`),
  computed from `ctx.sql`. It walks each execution's `planTree` and keys every
  scan by its stable pre-AQE identity via `scanRelationId` (`plan-summary.ts`):
  `parquet:<db.table>`, `delta:<db.table>`, `jdbc:<schema.table>`. That dedupes
  relations within one execution (self-joins count once) and flags any relation
  scanned by `>= minExecutions` (2) distinct executions. Relation identity comes
  from the catalog-qualified scan name (nodeName, e.g.
  `Scan parquet spark_catalog.db.t`), not the `Location:` path, since Spark
  truncates that path at ~100 chars and points it at `_delta_log` for Delta
  tables; internal Delta-log metadata scans are dropped. Read bytes come from
  the scan's `size of files read` metric (`0`/unknown for JDBC). Findings carry
  `executionReuse` (`value` = distinct-execution count), `relation`, `format`,
  `executionIds`, `totalReadBytes`, and a size-aware `recommendation`
  (`confidence` scaled `low`/`medium`/`high` via `cachingReuseConfidence` off
  reuse-execution count, plus `validationRequired`). Renders nothing when clean (no card
  in the DOM). One row per relation: name + format badge, reuse count, `Data
  read` (`formatBytes`, em-dash when unknown), recommendation, sorted by
  `totalReadBytes` then reuse count descending. Rows reveal 6 initially, then up
  to 30 more per click. Pure-RDD-API apps (no SQL executions) produce no finding:
  a deliberate trade-off replacing the former RDD-lineage heuristic, which
  surfaced only internal query-engine RDDs on DataFrame/SQL workloads.

  It also detects composite reuse. When the same join/union subtree (not just a
  leaf scan) recurs across `>= minExecutions` distinct SQL executions, the
  detector emits one `variant:'composite'` finding recommending caching the
  derived join/union result instead of two independent leaf-relation rows, and
  suppresses the leaf findings for relations fully covered by it. A relation
  reused beyond the composite's executions keeps a residual leaf finding for
  just the uncovered executions. Composite identity is structural: an anchor
  plan-shape fingerprint (`findCompositeCandidates`/`computePlanShapes`'s
  `opts.includeDetail` path, `detectors.ts`) folds the join/union node's own
  normalized `detail` (join type, columns, literals, with expr ids,
  `plan_id=`, codegen-stage numbers, and AQE's BuildLeft/BuildRight stripped,
  and commutative equality operands canonicalized) plus its children's
  detail-free shapes. Descendant nodes never contribute detail text, only
  structural shape, so a shared join reused across differently-filtered
  pre-join scans still matches (a deliberate trade-off) while a different
  join *condition* on the same tables does not collide. Nested
  composites (an inner join reused both standalone and inside an outer join)
  dedupe one level at a time: an inner composite fully covered by a
  qualifying outer composite's execution set is suppressed entirely, and a
  superset recomputes a residual finding over just its extra executions.
  Reuse via pure projection/aggregation with no join/union underneath stays
  leaf-level, not modeled as composite. `variant:'composite'` findings carry
  `operator` (`'join'`|`'union'`), `relations` (leaf relations under the
  composite, for display), and `format:'derived'` (a sentinel: composites have
  no scan storage format). They render a `JOIN`/`UNION` operator badge (styled
  distinct from the format badges) plus a confidence marker
  (`confidence` scaled via `cachingReuseConfidence`, `validationRequired`) in
  `CachingOpportunity.tsx`.
- **Autoscaling Churn** (tag `CHRN`, `AutoscalingChurn.tsx`): app-level
  short-lived-executor detector (DETECTORS entry `autoscalingChurn` in
  `packages/core/src/detectors.ts`; reuses the same `executorsAdded`/`executorsRemoved`
  matching logic as `utilization`). For each added executor, finds its matching
  removal event (falling back to `app.endTime` for an executor still alive when
  the log ends) and flags it short-lived if its lifetime is under 2 minutes
  (`thresholds.shortLivedMs`). Warns above 30% short-lived, escalates to
  critical above 60% (`confidence` scales `low`/`medium`/`high` via
  `autoscalingChurnConfidence`, off how far the short-lived share sits past
  `warningPct`/`criticalPct`: these thresholds are still an unvalidated
  design-spike estimate, not yet checked against real autoscaling-heavy
  logs). Returns no finding below 5 total executors (noise
  floor) or when `app.endTime` is missing (truncated/still-running log). The
  widget itself is unchanged apart from a finding-driven verdict banner
  (impact dot + `CHRN` tag + recommendation) above its existing add/remove
  chart. The chart's muted scale-down bar coloring is untouched. Its
  `docAnchor` is `#bottleneck-autoscaling-churn`, a section of the
  cluster-config chapter (`docs-content/chapters/11-cluster-config.md`), not
  a bottleneck page of its own: `pageForAnchor` maps it there, so the `CHRN`
  pill opens `cluster-config.html#bottleneck-autoscaling-churn`.
- **Config Audit** (tag `CFG`): static Spark-config sanity findings derived from
  `app.config`/`app.resources` (parsed from `SparkListenerEnvironmentUpdate`):
  dynamic-allocation vs.
  shuffle-service mismatch, inverted/missing autoscaling bounds, non-Kryo
  serializer, low executor `memoryOverhead`. Computed outside the runtime
  bottleneck catalog: its findings live in the separate `configFindings`
  stream, not `catalog`. But `FixTheseFirst`/`Alerts` both merge `catalog`
  and `configFindings` (neither reads `region` any more), so a Config Audit
  finding is still eligible for a row in the Findings tab's recommendation
  rollup and still gets its own card in the active grid, alongside genuine
  bottleneck-catalog findings.
- **Plan Advisor** (tag `PLAN`): SQL-plan-level findings computed from
  `appModel.sql`'s resolved `planTree` (DETECTORS entries
  `duplicatePlanSubtree`, `smallFiles`, `broadcastSizing` in
  `packages/core/src/detectors.ts`): repeated plan subtrees (≥3 nodes, ≥2 occurrences, critical if the
  repeated root is an `Exchange`), small-files read/write (>100 files
  averaging <3 MiB), and broadcast-join sizing in both directions (missed-
  broadcast info finding, over-broadcast warning at >1 GB). Each of the four
  emitted types now renders as its own card (`DuplicatePlanSubtree.tsx`,
  `SmallFiles.tsx`, `UnderBroadcast.tsx`, `OverBroadcast.tsx`; the
  2026-09 widget/finding-type 1:1 mapping redesign split what used to be one
  shared `PlanFindings.tsx` card): all four still share the `PLAN` tag and
  the same `--plan-aggregate` badge tint (`src/view/plan-finding-shared.ts`).
  Their `docAnchor`s (`#bottleneck-duplicate-plan-subtree`,
  `#bottleneck-small-files`, `#bottleneck-broadcast-sizing`) each resolve to
  their own page in the vendored tuning reference.

`detector-registry.tsx`'s `REGISTRY` still carries `region: 'reference'` on
four entries, each its own component now: `memoryUtilization`
(`MemoryUtilization`), `utilization` (`ExecutorUtilization`),
`cacheUtilization` (`CacheUtilization`), and `coreLocality`
(`CoreUsageArea`). `broadcastSizing` is gone from `REGISTRY` entirely (the
2026-09 widget/finding-type 1:1 mapping redesign dropped it): it never
backed a real `Finding` (the `broadcastSizing` `DETECTORS` entry only ever
emits `underBroadcast`/`overBroadcast`, both `region: 'action'`, each now
its own Plan Advisor card), so there is no key left for it to occupy or a
clean-check line for it to render.
Autoscaling Churn, the other executor-provisioning-lifecycle detector
alongside `utilization`/`memoryUtilization`, was deliberately given `action`
rather than `reference` (see "Beyond the fixed six" above).

`region` decides one thing (see
[Widget rendering order](./widget-rendering.md#widget-rendering-order-fixed-spec-§5)):
whether a widget always mounts. `isAlwaysMountedType()` flags exactly one
of the four `reference`-region types: Core Usage by Locality. That one
mounts unconditionally from `appModel` in its own small grid inside the
Findings tab, regardless of finding state. Memory Utilization, Executor
Utilization, and Cache Storage are `reference` too, but all three are
excluded by product decision, not a component-sharing constraint
(`ALWAYS_MOUNTED_EXCEPTIONS` in `src/view/detector-registry.tsx` carries
`cacheUtilization`, `memoryUtilization`, and `utilization`): a clean run on
any of them isn't evidence worth surfacing unconditionally, so each
collapses to an ordinary `CleanCheckRow` like any other action-region type
on a clean run. Every other `REGISTRY` widget still renders unconditionally
as either an active card or a clean-check line, and `region` still sets
`orderedWidgets()`'s sort order within the active grid (`action` components
first, `reference` ones after). The Full app report tab is structural-only
and reads no `REGISTRY` entry. So Core Usage by Locality, the one widget
still tagged `region: 'reference'` and exempt from `ALWAYS_MOUNTED_EXCEPTIONS`,
renders in the Findings tab's always-visible grid rather than inside a
separate Reference region (Memory Utilization, Executor Utilization, and
Cache Storage all render through the ordinary active/clean paths instead):

- **Memory Utilization** (tag `MEM`): app-level card combining three
  sub-findings from the `memoryUtilization` DETECTORS entry
  (`packages/core/src/detectors.ts`): idle-cores rate (busy-core-time from the worker's
  run-aggregates sweep vs. peak-cores × wall-clock), per-executor memory bands
  (peak heap vs. allocated, gated on `spark.eventLog.logStageExecutorMetrics`:
  a distinct `dataUnavailable` finding renders when that config was off), and
  an unverified memory-waste model (`confidence` scales `low`/`medium`/`high`
  via `memoryWasteConfidence`, off how far the wasted/used ratio sits past
  the 1.5× buffer).
  The driver-memory half of the original spec is dropped: the worker only
  extracts *allocated* `spark.driver.memory`, never a driver actual-usage
  metric, so there is nothing to band against. The separate `utilization`
  DETECTORS entry (an `avgUtilization` info finding: active-executor-time
  fraction below 60%) has its own card, **Executor Utilization** (tag
  `UTIL`, `ExecutorUtilization.tsx`): a `reference`-region widget in its own
  right that renders only with an active finding, split out of this same
  combined widget in the 2026-09 widget/finding-type 1:1 mapping redesign
  (it used to render inline here; the former `ExecutorTimeline.tsx` never
  owned this type, despite the tag's letters).
- **Cache Storage** (tag `CSTOR`): app-level card driven by the
  `cacheUtilization` DETECTORS entry (`packages/core/src/detectors.ts`), evaluating two
  per-RDD proxies over `ctx.app.rddInfo` since Spark event logs carry no
  runtime block-access/read-count data. `rddInfo`'s cache figures come from
  `SparkListenerBlockUpdated` (`recordBlockUpdate` in `event-handlers.ts`,
  only written with `spark.eventLog.logBlockUpdates.enabled=true`): each
  RDD's peak count of resident partitions, with the memory/disk bytes at the
  latest moment that peak held, so an `unpersist()` before the log ends
  doesn't erase it. Without block updates they fall back to
  `SparkListenerStageSubmitted`'s RDD Info, which is always 0 since Spark 2.3
  and real only on Spark 1.x logs (`storageSource` records which). The two
  proxies are partial caching
  (`numCachedPartitions / numPartitions < 0.90`, `< 0.50` for the warning
  tier) and disk spillover for `MEMORY_AND_DISK*` RDDs
  (`diskSize / (memorySize + diskSize) > 0.15`, `> 0.40` for the warning
  tier; `DISK_ONLY` RDDs are never flagged). `confidence` scales `low`/`medium`/`high`
  via `cacheSampleConfidence(rdd.numPartitions)`, because the ratio is a
  storage snapshot, not a runtime read-count, and more partitions average
  that snapshot noise into a more stable ratio. When persisted RDDs have no
  storage evidence at all (no block updates, and every RDD Info figure 0),
  the detector emits one `storageUnobserved` caveat (`dataUnavailable: true`,
  `info`) naming `spark.eventLog.logBlockUpdates.enabled`. Unlike
  `memoryUtilization`'s caveat it counts for `isRealFinding`, so the card
  still mounts (with the caveat and no table) and Cache Storage never lands
  in Clean checks for a run that couldn't be checked; `isEligible` keeps it
  out of Fix these first. The existing RDD
  table (ported from the legacy `src/widgets/cache-utilization.js` canvas
  widget) still renders unconditionally; flagged rows get an inline `CSTOR`
  tag next to the RDD name, and every flagged RDD's recommendation renders
  below the table, worst-first.
- **Core Usage by Locality** (tag `LOCAL`, `CoreUsageArea.tsx`): app-level
  non-local-task-ratio threshold (DETECTORS entry `coreLocality`; the other
  half of a wasted-cores-ratio check, the idle-core half already
  covered by Memory Utilization's `idleCores` variant above). Sums
  `RACK_LOCAL` + `ANY` task counts against total task count across every
  stage's `stage.localityStats` (pure reducer `computeCoreLocalityRatio`,
  `packages/core/src/core-locality-ratio.ts`). `NO_PREF` stays in the denominator only,
  since it's what shuffle-read stages legitimately report with no locality
  problem. Below 50 total tasks or below a 15% non-local ratio: no finding;
  15%-35%: warning; >= 35%: critical, still unvalidated design-spike
  thresholds (`confidence` scales `low`/`medium`/`high` via
  `coreLocalityConfidence`, off whichever is weaker of the non-local ratio
  and the sampled task count, the same evidence-strength convention as the
  memory-waste model above).
  The widget's always-rendered stacked-area chart (`packages/core/src/core-usage-locality.ts`)
  is unaffected. The finding only adds a threshold/impact-band section above it, a
  per-stage non-local breakdown below it (shown whenever any non-local tasks
  exist at all, independent of whether the aggregate crossed threshold), and
  a one-line cross-reference to Memory Utilization when its `idleCores`
  finding also fired (idle-core ratio itself is not duplicated here).

Documented ALL-CAPS tag vocabulary: `SKEW`, `SHFL`, `SPILL`, `GC`, `COLD`,
`UTIL`, `MEM` (Memory Utilization), `CSTOR` (Cache Storage), `LOCAL`
(Core Usage by Locality), plus `FAIL` (Failed Tasks), `JOBS` (Job Failures),
`CFG` (Config Audit), `PLAN` (Plan Advisor), `SFAIL` (stage failed outright),
`PART` (partition sizing), `SLOW` (stage overall slowness), `SHAPE` (stage
shape smells), `CACHE` (caching opportunity) and `CHRN` (autoscaling churn).

ETL Phase Attribution (`packages/core/src/etl-phases.ts` + `EtlPhases.tsx`),
What-If Executor Scaling (`packages/core/src/scaling-sim.ts` + `ScalingSim.tsx`,
design spike: makespan predictions are unvalidated and carry a Model Error
indicator), and Compute Efficiency (`packages/core/src/efficiency-model.ts` +
`EfficiencyModel.tsx`, design spike: driver-vs-executor waste
split, two theoretical floors, and the §6 right-sizing copy) are main-thread
report modules, not `DETECTORS` entries: descriptive lenses with no
impact-band threshold, rendered unconditionally into the Full app report tab
rather than participating in the bottleneck catalog. `packages/core/src/job-groups.ts`
(`checkConcurrentJobGroups`) is likewise a report helper: it flags when
concurrent SQL-execution job groups make wall-clock-based estimates
unreliable, and both the scaling simulator and the efficiency model gate their
precision on it, showing a caveat banner rather than suppressing the estimate.

## Confidence metadata

Best-effort (non-deterministic) findings carry a `confidence` +
`validationRequired` marker, rendered inline by each consuming widget (e.g.
`Spill.tsx`, `DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`, `UnderBroadcast.tsx`,
`OverBroadcast.tsx`, `EfficiencyModel.tsx`) when `confidence` is
present and not `'high'`. There is no shared helper: each widget renders its
own muted "N confidence: verify" text, with the `title` attribute carrying
`validationRequired` as a tooltip. Spill classification is `medium` when
classified (skew/volume) and `low` when unclassified; plan-summary warnings
are `low`. Deterministic detectors stay unmarked, treated as high confidence.

## Visual system

Tailwind CSS v4 + shadcn/ui (Base UI primitives). The design tokens (colors,
including the telemetry-console dark palette) are defined as CSS variables in
an `@theme inline` block and consumed via Tailwind utility classes; there is
no more hand-authored BEM CSS. Theme polarity is unchanged from the legacy
app: dark = bare `:root` (no attribute), light =
`:root[data-theme="light"]`, toggled by `src/theme/ThemeProvider.tsx` and
persisted to `localStorage`. `index.html`'s inline FOUC-prevention script
still runs before React mounts. Mono is still the typeface for numerics
(`--font-mono`), applied via a `.num`-equivalent Tailwind utility per call
site rather than one global class. Charts are Recharts
(`src/view/charts/ChartTheme.tsx`'s `CHART_COLORS`, read from the same CSS
tokens) instead of Chart.js. React re-renders on theme toggle, so chart colors
update live with the theme, unlike the old Chart.js canvases, which were built
once per parse. `ChartFrame` can also expose the underlying rows through a
toggleable accessible table and copy them to the clipboard as TSV.

## Templating (XSS-safe)

JSX auto-escapes every interpolated value by default. The hand-rolled
auto-escaping `` html`` `` tagged template (`src/widgets/utils.js`) and its
`no-raw-innerhtml` guard test are gone, and no `.innerHTML` assignment is
left anywhere in the view layer.

One Base UI-specific gotcha carried no equivalent in the legacy app:
`WidgetCard.tsx` passes `aria-expanded={String(open) as 'true' | 'false'}`
rather than the raw boolean, because Base UI's `Collapsible.Trigger` otherwise
overrides a boolean `aria-expanded` prop with its own internal state via prop
merging. The explicit `String()` cast keeps the rendered attribute in sync
with this app's own `open` state.
