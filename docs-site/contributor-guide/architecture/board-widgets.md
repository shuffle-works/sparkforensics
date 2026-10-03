# Board widgets

## App- and plan-level widgets {#board-widgets-app-and-plan-widgets}

(Components below live in `src/view/widgets/`, one file per widget name,
e.g. `JobFailures.tsx`, `MemoryUtilization.tsx`.)

Beyond the stage-level cards, nine app- and plan-level cards render in the
Findings tab, all `region: 'action'` in `detector-registry.tsx`: Incomplete
Run, Job Failures, Caching Opportunities, Autoscaling Churn, Config Audit, and
the four Plan Advisor cards (Redundant Plan Subtree, Excessive Small Files, Missed
Broadcast Join, Oversized Broadcast Join). `REGISTRY` maps every finding type
to its own component: 24 `action` and 4 `reference` entries.

- **Incomplete Run** (tag `INCMP`, `IncompleteRun.tsx`): app-level "the
  capture never finished" caveat (DETECTORS entry `incompleteRun`). Fires
  whenever `app.startTime` was observed but `app.endTime` was not, i.e. no
  `SparkListenerApplicationEnd` in the log: an in-flight job, a rotated-away
  log, or a capture cut short. Order 5, the lowest of any detector, so within
  the Warning band (its fixed impact band) its card comes first. The Findings tab's recommendation rollup (rendered by `FixTheseFirst.tsx`)
  excludes `incompleteRun` from that list outright (see
  [Widget rendering order](./widget-rendering.md#widget-rendering-order)):
  it's a pipeline-completeness caveat, not an addressable fix, so it never
  competes with other findings for a ranked slot there. Self-gates to `null`
  (no card in the DOM) once the run completed normally. Unrelated to
  `evidence-availability.ts`'s own
  `trustworthy` gate (see
  [Evidence-availability contract](./worker-protocol/evidence-availability.md#evidence-availability-contract)):
  that ledger only downgrades *absence* conclusions for individual evidence
  categories, never becomes a `DETECTORS` finding itself, and this card does
  not read it. No `docAnchor` is set: this is a tool-specific signal with no
  upstream `spark-tuning-reference` section.
- **Job Failures** (tag `JOBS`): app-level job-failure-rate rollup
  (DETECTORS entry `jobFailureRate` in `packages/core/src/detectors.ts`), computed from
  the run's `jobs` map (`ctx.jobs`, `SparkListenerJobEnd` results):
  ≥10% info, ≥30% warning, ≥50% critical. Complements the per-stage,
  task-level Failed Tasks card (tag `FAIL`).
- **Caching Opportunities** (tag `CACHE`, `CachingOpportunity.tsx`):
  app-level SQL relation-reuse detector (DETECTORS entry `cachingOpportunity`),
  computed from `ctx.sql`. It walks each execution's `planTree` and keys every
  scan by its stable pre-AQE identity via `scanRelationId` (`plan-summary.ts`):
  `<parquet|orc|csv|json>:<db.table>`, `delta:<db.table>`, `jdbc:<schema.table>`. That dedupes
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
  read` (`formatBytes`, em-dash when unknown), sorted by `totalReadBytes` then
  reuse count descending; the card states the fix once (`fixFor`), not per row. Rows are paged `VISIBLE_LIMIT`
  (6) at a time (`usePagedRows` + `RowPagination`), and a route to a row jumps
  to its page. Pure-RDD-API apps (no SQL executions) produce no finding:
  a deliberate trade-off, since an RDD-lineage heuristic surfaces only
  internal query-engine RDDs on DataFrame/SQL workloads.

  It also detects composite reuse. When the same join/union subtree (not just a
  leaf scan) recurs across `>= minExecutions` distinct SQL executions, the
  detector emits one `variant:'composite'` finding recommending caching the
  derived join/union result instead of two independent leaf-relation rows, and
  suppresses the leaf findings for relations fully covered by it. A relation
  reused beyond the composite's executions keeps a residual leaf finding for
  just the uncovered executions. Composite identity is structural: an anchor
  plan-shape fingerprint built by `findCompositeCandidates`
  (`packages/core/src/detectors.ts`; the same shape `computePlanShapes`
  produces with `opts.includeDetail`, computed inline in one bottom-up pass)
  folds the join/union node's own
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
  `warningPct`/`criticalPct`: these thresholds are unvalidated
  estimates, not checked against real autoscaling-heavy
  logs). Returns no finding below 5 total executors (noise
  floor) or when `app.endTime` is missing (truncated/still-running log). The
  widget shows a finding-driven verdict banner (impact dot + `CHRN` tag +
  recommendation) above its add/remove chart, whose scale-down bars are
  muted. Its
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
  and `configFindings` (neither reads `region`), so a Config Audit
  finding is eligible for a row in the Findings tab's recommendation
  rollup and gets its own card in the active grid, alongside genuine
  bottleneck-catalog findings.
- **Plan Advisor** (tag `PLAN`): SQL-plan-level findings computed from
  `appModel.sql`'s resolved `planTree` (DETECTORS entries
  `duplicatePlanSubtree`, `smallFiles`, `broadcastSizing` in
  `packages/core/src/detectors.ts`): repeated plan subtrees (≥3 nodes, ≥2 occurrences; dropped when their
  linked stages take under 0.5% of the run; banded from the recovered
  wall-clock like other findings, with a `warning`/`info` fallback; an
  `Exchange` root only changes the recommendation to a possible missed
  exchange reuse), small-files read/write (>100 files
  averaging <3 MiB), and broadcast-join sizing in both directions (missed-
  broadcast info finding, over-broadcast warning at >1 GB). Each of the four
  emitted types renders as its own card (`DuplicatePlanSubtree.tsx`,
  `SmallFiles.tsx`, `UnderBroadcast.tsx`, `OverBroadcast.tsx`): all four
  share the `PLAN` tag and
  the same `--plan-aggregate` badge tint (`src/view/plan-finding-shared.ts`).
  Their `docAnchor`s (`#bottleneck-duplicate-plan-subtree`,
  `#bottleneck-small-files`, `#bottleneck-broadcast-sizing`) each resolve to
  their own page in the vendored tuning reference.

`detector-registry.tsx`'s `REGISTRY` carries `region: 'reference'` on
four entries, each its own component: `memoryUtilization`
(`MemoryUtilization`), `utilization` (`ExecutorUtilization`),
`cacheUtilization` (`CacheUtilization`), and `coreLocality`
(`CoreUsageArea`). `broadcastSizing` has no `REGISTRY` entry: it never
backs a real `Finding` (the `broadcastSizing` `DETECTORS` entry only
emits `underBroadcast`/`overBroadcast`, both `region: 'action'`, each
its own Plan Advisor card), so there is no key for it to occupy or
clean-check line for it to render.
Autoscaling Churn, the other executor-provisioning-lifecycle detector
alongside `utilization`/`memoryUtilization`, is `action`, not `reference`
(see "App- and plan-level widgets" above).

`region` decides one thing (see
[Widget rendering order](./widget-rendering.md#widget-rendering-order)):
whether a widget always mounts. `isAlwaysMountedType()` flags exactly one
of the four `reference`-region types: Core Usage by Locality. That one
mounts unconditionally from `appModel` at the head of the Full app report
tab's reference grid, regardless of finding state. Memory Utilization, Executor
Utilization, and Cache Storage are `reference` too, but all three are
excluded by product decision, not a component-sharing constraint
(`ALWAYS_MOUNTED_EXCEPTIONS` in `src/view/detector-registry.tsx` carries
`cacheUtilization`, `memoryUtilization`, and `utilization`): a clean run on
any of them isn't evidence worth surfacing unconditionally, so each
collapses to an ordinary `CleanCheckRow` like any other action-region type
on a clean run. Every other `REGISTRY` widget renders unconditionally
as either an active card or a clean-check line, and `region`, then detector
order, breaks ties between cards of the same impact band
(`computeActiveWidgets` ranks by worst impact band first; `ImpactBoard`
groups cards Critical, Warning, Info). The Full app report tab reads no other
`REGISTRY` entry. So Core Usage by Locality, the one widget tagged
`region: 'reference'` and exempt from `ALWAYS_MOUNTED_EXCEPTIONS`, renders
in the Full app report beside the other run-wide reference views, and a
route to a `coreLocality` finding switches to that tab (Memory Utilization, Executor Utilization, and
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
  There is no driver-memory band: the worker only
  extracts *allocated* `spark.driver.memory`, never a driver actual-usage
  metric, so there is nothing to band against. The separate `utilization`
  DETECTORS entry (an `avgUtilization` info finding: active-executor-time
  fraction below 60%) has its own card, **Executor Utilization** (tag
  `UTIL`, `ExecutorUtilization.tsx`): a `reference`-region widget in its own
  right that renders only with an active finding.
- **Cache Storage** (tag `CSTOR`): app-level card driven by the
  `cacheUtilization` DETECTORS entry (`packages/core/src/detectors.ts`), evaluating two
  per-RDD proxies over `ctx.app.rddInfo` since Spark event logs carry no
  runtime block-access/read-count data. `rddInfo`'s cache figures come from
  `SparkListenerBlockUpdated` (`recordBlockUpdate` in `event-handlers.ts`,
  only written with `spark.eventLog.logBlockUpdates.enabled=true`): each
  RDD's peak count of resident partitions, with the memory/disk bytes at the
  latest moment that peak held, so an `unpersist()` before the log ends
  doesn't erase it. A block's bytes count only where its storage level says
  it lives (as in Spark's `AppStatusListener`): a drop from memory to disk
  still reports the dropped bytes as `Memory Size`. A removed executor's
  blocks are dropped with it (Spark logs no update for them), and once an RDD
  has block updates a later stage's RDD Info can't reset its storage level
  to `NONE` after an `unpersist()`. The corpus
  `cache-memory-only` and `cache-memory-and-disk` logs exercise both rules. Without block updates they fall back to
  `SparkListenerStageSubmitted`'s RDD Info (`storageSource` records which),
  which is always 0 since Spark 2.3; Spark 1.x fills it only on
  `StageCompleted`, which isn't read. The two
  proxies are partial caching
  (`numCachedPartitions / numPartitions < 0.90`, `< 0.50` for the warning
  tier) and disk spillover for `MEMORY_AND_DISK*` RDDs
  (`diskSize / (memorySize + diskSize) > 0.15`, `> 0.40` for the warning
  tier; `DISK_ONLY` RDDs are never flagged). `confidence` scales `low`/`medium`/`high`
  via `cacheSampleConfidence(rdd.numPartitions)`, because the ratio is a
  storage snapshot, not a runtime read-count, and more partitions average
  that snapshot noise into a more stable ratio. When persisted RDDs have no
  storage evidence at all (no block updates, block-update logging not
  enabled in the app config, a recorded Spark version of 2.3 or later, and every RDD
  Info figure 0),
  the detector emits one `storageUnobserved` caveat (`dataUnavailable: true`,
  `info`) naming `spark.eventLog.logBlockUpdates.enabled`. Unlike
  `memoryUtilization`'s caveat it counts for `isRealFinding`, so the card
  still mounts (with the caveat and no table) and Cache Storage never lands
  in Clean checks for a run that couldn't be checked; `isEligible` keeps it
  out of Fix these first. The RDD
  table renders unconditionally; flagged rows get an inline `CSTOR`
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
  15%-35%: warning; >= 35%: critical; these thresholds are unvalidated estimates
  (`confidence` scales `low`/`medium`/`high` via
  `coreLocalityConfidence`, off whichever is weaker of the non-local ratio
  and the sampled task count, the same evidence-strength convention as the
  memory-waste model above).
  The widget's always-rendered stacked-area chart (`packages/core/src/core-usage-locality.ts`)
  does not depend on the finding. The finding adds a threshold/impact-band section above it, a
  per-stage non-local breakdown below it (shown whenever any non-local tasks
  exist at all, independent of whether the aggregate crossed threshold), and
  a one-line cross-reference to Memory Utilization when its `idleCores`
  finding also fired (idle-core ratio itself is not duplicated here).

Documented ALL-CAPS tag vocabulary: `SKEW`, `SHFL`, `SPILL`, `GC`, `COLD`,
`UTIL`, `MEM` (Memory Utilization), `CSTOR` (Cache Storage), `LOCAL`
(Core Usage by Locality), plus `FAIL` (Failed Tasks), `JOBS` (Job Failures),
`CFG` (Config Audit), `PLAN` (Plan Advisor), `SFAIL` (stage failed outright),
`PART` (partition sizing), `SLOW` (stage overall slowness), `SHAPE` (stage
shape smells), `CACHE` (caching opportunity), `CHRN` (autoscaling churn),
`TINY` (tiny tasks), `RETRY` (retry waste), `HOST` (slow executor host),
`STRAG` (straggling task), `SPEC` (speculation waste) and `INCMP` (incomplete
run); `packages/core/test/tag-vocabulary.test.js` checks the list.

ETL Phase Attribution (`packages/core/src/etl-phases.ts` + `EtlPhases.tsx`),
What-If Executor Scaling (`packages/core/src/scaling-sim.ts` + `ScalingSim.tsx`,
makespan predictions are unvalidated and carry a Model Error
indicator), and Compute Efficiency (`packages/core/src/efficiency-model.ts` +
`EfficiencyModel.tsx`, available vs. used core-hours with
`wasted-core-hours.ts`'s top stages by task core-time, the driver-vs-executor
waste split, two theoretical floors, and the right-sizing copy) are main-thread
report modules, not `DETECTORS` entries: descriptive lenses with no
impact-band threshold, rendered unconditionally into the Full app report tab
rather than participating in the bottleneck catalog. `packages/core/src/job-groups.ts`
(`checkConcurrentJobGroups`) is likewise a report helper: it flags when
concurrent SQL-execution job groups make wall-clock-based estimates
unreliable. It feeds the run interpretation's `wallClockReliable`; the
scaling simulator and the efficiency model read that flag and show a caveat
banner rather than suppressing the estimate. The same Full app report grid
also holds Evidence Availability and the Core Usage Histogram.

## Confidence metadata

Best-effort (non-deterministic) findings carry a `confidence` +
`validationRequired` marker, rendered by the shared `RowStatusCluster`
(`src/view/RowStatusCluster.tsx`) when `confidence` is present and not
`'high'`: a muted "`<level>` confidence" pill whose accessible tooltip
(`useAccessibleTooltip`: `title` + `aria-describedby`, keyboard-focusable)
carries `validationRequired`. Consumers include `Spill.tsx`,
`DuplicatePlanSubtree.tsx`, `SmallFiles.tsx`, `UnderBroadcast.tsx`,
`OverBroadcast.tsx`, `CachingOpportunity.tsx`, `PlanView.tsx` and
`EfficiencyModel.tsx`. Spill classification is `medium` when
classified (skew/volume) and `low` when unclassified; plan-summary warnings
are `low`. Deterministic detectors stay unmarked, treated as high confidence.

## Visual system

Tailwind CSS v4 + shadcn/ui (Base UI primitives). The design tokens (colors,
including the telemetry-console dark palette) are defined as CSS variables in
an `@theme inline` block and consumed via Tailwind utility classes; there is
no hand-authored BEM CSS. Theme polarity:
dark = bare `:root` (no attribute), light =
`:root[data-theme="light"]`, toggled by `src/theme/ThemeProvider.tsx` and
persisted to `localStorage`. `index.html`'s inline FOUC-prevention script
runs before React mounts. Mono is the typeface for numerics
(`--font-mono`), applied via a `.num`-equivalent Tailwind utility per call
site rather than one global class. Charts are Recharts
(`src/view/charts/ChartTheme.tsx`'s `CHART_COLORS`, read from the same CSS
tokens). React re-renders on theme toggle, so chart colors
update live with the theme. `ChartFrame` can also expose the underlying rows through a
toggleable accessible table and copy them to the clipboard as TSV.

## Templating (XSS-safe)

JSX auto-escapes every interpolated value by default. No `.innerHTML`
assignment exists anywhere in the view layer (the one `dangerouslySetInnerHTML`,
shadcn's `ChartStyle` in `src/components/ui/chart.tsx`, only writes CSS
variables from the static chart config).

One Base UI-specific gotcha:
`WidgetCard.tsx` passes `aria-expanded={String(open) as 'true' | 'false'}`
rather than the raw boolean, because Base UI's `Collapsible.Trigger` otherwise
overrides a boolean `aria-expanded` prop with its own internal state via prop
merging. The explicit `String()` cast keeps the rendered attribute in sync
with this app's own `open` state.
