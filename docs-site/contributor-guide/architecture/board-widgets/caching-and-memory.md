# Caching and memory widgets

The board widgets for caching opportunities, memory utilization and cache storage.

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

- **Memory Utilization** (tag `MEM`): app-level card combining three
  sub-findings from the `memoryUtilization` DETECTORS entry
  (`packages/core/src/detectors.ts`): idle-cores rate (busy-core-time from the worker's
  run-aggregates sweep vs. the run's allocated core time, `metrics.allocation.coreHours`), per-executor memory bands
  (peak heap vs. allocated, gated on `spark.eventLog.logStageExecutorMetrics`:
  a distinct `dataUnavailable` finding renders when that config was off), and
  an unverified memory-waste model (`confidence` scales `low`/`medium`/`high`
  via `memoryWasteConfidence`, off how far the wasted/used ratio sits past
  the 1.5× buffer).
  There is no driver-memory band: the worker only
  extracts *allocated* `spark.driver.memory`, never a driver actual-usage
  metric, so there is nothing to band against. The separate `utilization`
  DETECTORS entry (an `avgUtilization` info finding: busy share of
  allocated core time below 60%) has its own card, **Executor Utilization** (tag
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
