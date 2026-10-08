---
"@sparkforensics/core": patch
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Correct findings and advice that were wrong or contradicted each other, found by reviewing the recently merged detector work.

- `--redact` keeps per-query settings (`modifiedConfigs` on a SQL execution) only for the Spark SQL tuning keys the findings read and replaces every other value (a path, a bucket, a host) with Spark's `*********(redacted)` placeholder. The `spark.redaction.string` lookup is removed: Spark's replacement text is a constant.
- Partition-count advice follows what sized the stage. A stage outside any SQL execution is never read as AQE-coalesced. `spark.sql.adaptive.coalescePartitions.initialPartitionNum` replaces the property as the starting count when set, and a task count above the configured one is not blamed on the stage's own `repartition(n)` unless the plan holds one: the advice states the counts. While `parallelismFirst` is on, the advice sets it to `false` first and raises the advisory size after it. `parallelismFirst`, `spark.executor.memoryOverheadFactor` and `spark.executor.minMemoryOverhead` join the defaults table.
- `coldStart` reads an unset `spark.dynamicAllocation.enabled` as off, as Spark and the idle-capacity finding do. Cold-start and churn runs that never set it no longer suggest executor-count properties.
- Missed-broadcast text names the case: a side over a small effective threshold, or automatic broadcast disabled with `-1`. For an adaptive plan it names `spark.sql.adaptive.nonEmptyPartitionRatioForBroadcastJoin` instead of table statistics.
- The missing executor heap peaks note names the cause (tasks shorter than the executor heartbeat report zeros) and suggests `spark.eventLog.logStageExecutorMetrics=true` while it is off. The driver's metric rows do not count as executor evidence, matching the heap-peak finding. The idle-memory waste model uses executor alive time instead of peak executors times the whole run.
- AQE skew-join diagnosis no longer judges summed left and right reads as one side: `evenReads` and the factor part of `belowThreshold` need one side to shuffle next to nothing, and a tail attributed to data volume is never called even or cured. A join with no stage ids is tied to a stage only by its exchanges or by matching shuffle bytes, so a later aggregate stage does not get the join's diagnosis. One-sided joins are advised to join the hot key on its own and union, not to swap sides. Skew factors print two decimals.
- Tail attribution takes ratios against the median or a floor of 1 MiB and 1,000 records, and with a median task that read nothing, GC and fetch wait claim their time before data does. A tail with no attributed cause is reported once, as a straggler with neutral wording and no key advice, instead of as both skew and straggler.
- Advice to lower executor memory conflicts with advice to raise it on the same stage: a stage's low-GC note is dropped there, and a run-level heap or idle-memory finding keeps its figures but not the advice to lower, and names the stages that ask for more. The low-GC note returns when heap peaks exist but the executor memory is unknown, and is never given on a stage that failed or lost tasks.
- Settings read through the effective Spark conf: dynamic-allocation bounds, `logBlockUpdates`, the memory overhead keys including Spark 4's `minMemoryOverhead`, container size, resources and the evidence ledger's stage-metrics switch.
- Wording: an `unexplained` straggler tail that read far more data says so and keeps data advice when data is its largest share, a median task that read almost nothing prints no ratio, cartesian joins with a condition, the Python UDF Arrow opt-out, and the straggler share's threshold.
- The landing page and the Dashboard no longer preload the plan-graph vendor chunk: the d3 modules recharts and xyflow share live in their own chunk. A post-build test pins the layout.
- The MCP run cache notices a file growing inside a rolling event-log directory. A cached comparison is dropped if either run left the cache while it was built, and each call receives its own copy of the result.
