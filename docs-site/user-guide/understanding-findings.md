# Understanding findings

Every flagged problem carries a short ALL-CAPS tag. This page has one entry
per tag: what it means, and what to do about it.

Each tag links to the matching section of the Spark
[tuning reference](../tuning-reference/index.md), opened in an in-app **Reference**
panel next to the board. `INCMP` has no reference section, so its tag opens
this page instead. Turn on [Advanced view](./getting-started.md#advanced-view)
to also see a finding's confidence when it is below high, and a page icon
beside the tag that opens this page's entry. Some tags point into another
tag's reference page because the material overlaps: `SFAIL` shares `FAIL`'s
section; `PART` is on the `SHFL` page, `SPEC` on `STRAG`, `SHAPE` on `SKEW`,
`SLOW` on `HOST`, and `CACHE`/`LOCAL` on `UTIL`.

## Per-stage

### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. For join-driven skew, enable AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`); otherwise salt the key or
repartition on a better key. Flagged when P95 task time (the longest task,
on a stage with fewer than 20 tasks) exceeds 3x the median and the
recoverable tail is at least 0.5% of the run.

### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join. Only flagged on
stages that take at least 0.5% of the run.

### `SPILL`: Memory and disk spill {#spill}

Tasks are writing data out of memory, which slows execution. Two spill
patterns get flagged differently: skew spill, where a few heavy tasks spill
while most don't (rebalance partitioning), and volume spill, where most
tasks spill because the data genuinely exceeds available memory (add
partitions or executor memory). Only flagged on stages that take at least 0.5% of the run.

### `GC`: Garbage collection pressure {#gc}

Tasks spend more than 10% of executor run time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.
A stage with GC below 5% gets an informational note that executor memory
may be over-provisioned, only on stages that take at least 0.5% of the run.
Both need at least 10 s of executor run time on the stage.

### `FAIL`: Failed tasks {#fail}

Tasks fail often enough to affect the stage. Failed tasks point to executor
instability or data-driven errors. The finding names the dominant error: the
exception class, or the executor loss reason (for example "Container killed
by YARN for exceeding memory limits"). It lists up to five distinct failures,
each with its message and a short stack excerpt. With redaction on, messages
become `[redacted]` and message lines inside excerpts are dropped, since they
can carry file paths and data values; class names, stack frames and the
executor loss reason stay (hosts in it are pseudonymized).

### `SFAIL`: Failed stage {#sfail}

A stage attempt failed outright rather than losing individual tasks within
it. Inspect the driver log for the failure reason and the job that triggered
it.

### `STRAG`: Straggler tasks {#strag}

A few tasks run much slower than the rest of their stage. Rule out a GC
pause or a slow shuffle fetch before assuming a hardware issue; if a skewed
key is the real cause, that's a candidate for AQE's skew-join handling. Only
flagged on stages that take at least 0.5% of the run.

### `SPEC`: Speculation waste {#spec}

Speculative task attempts used a lot of executor time without confirming a
genuine straggler. Self-flags a confidence that scales with how far the
wasted time sits past the threshold: these thresholds are still a design
spike, not yet validated against real-world runs. If task durations are
just naturally variable rather than genuine stragglers, tune
`spark.speculation.multiplier`/`spark.speculation.quantile`.

### `RETRY`: Retry waste {#retry}

Repeated task attempts ate into execution time even though the stage
completed. Investigate executor loss or fetch failures.

### `TINY`: Tiny tasks {#tiny}

Many very short tasks add scheduling overhead out of proportion to the work
each one does. Repartition to fewer, larger tasks. Only flagged on stages that
take at least 0.5% of the run.

### `PART`: Partition sizing {#part}

Shuffle partitions are too large, too uneven, or too few for the work. A
single shuffle partition over 5 GB, for example, will OOM or spill heavily:
repartition to break it up before the stage runs.

### `SLOW`: Stage slowness {#slow}

A stage ran for 15 minutes or more and no slow host was flagged on it. It
can appear alongside other findings on the same stage. Often a partition-count problem: raise parallelism via
`spark.sql.shuffle.partitions` or `spark.default.parallelism`, or check for a
large per-task data volume driving heavy shuffle and spill.

### `SHAPE`: Stage shape {#shape}

The stage has an inefficient task count, output shape (output more than 10×
input), or task-to-stage balance: one straggler task running for more than
half the stage's wall-clock time and over 3× the median task, so it alone
sets when the stage ends. A too-low task count and a straggler are only
flagged on stages that take at least 0.5% of the run.

### `HOST`: Slow host {#host}

One executor is much slower than its peers, or carries most of the stage's
task time or bytes. It may just hold data locality
for its tasks or carry one heavy stage, rather than a hardware fault.
Enable `spark.speculation` to relaunch a lagging task automatically. Only
flagged on stages that take at least 0.5% of the run.

## App-level

### `COLD`: Executor cold start {#cold}

The first stage waited more than 30 s for an executor. Keep a warm pool of
executors, or, with dynamic allocation, raise
`spark.dynamicAllocation.minExecutors`/`initialExecutors` so the app doesn't
scale up from zero.

### `UTIL`: Low utilization {#util}

Allocated executors sit idle for a large share of the application run.
Consider a smaller cluster, or enable dynamic allocation.

### `MEM`: Memory utilization {#mem}

Executor memory or core capacity may be over- or under-provisioned: more
than 50% of allocated core time ran no task, an executor's heap peaked above
95% of its allocation, or it stayed below 70%. Some
detail here needs `spark.eventLog.logStageExecutorMetrics=true` on the run
being analyzed; without it, per-executor memory usage can't be broken down.
Review `spark.executor.memory` and executor count if allocated memory sat
largely idle over the run. That idle-memory variant self-flags a confidence
that scales with how far the estimated waste sits past a 1.5x buffer: it
estimates waste from allocated memory-time versus task run time (not
measured heap usage). Check it against
the Spark UI before resizing anything.

### `CACHE`: Caching opportunity {#cache}

A reusable dataset (re-read via the same SQL relation more than once, or a
join/union result recomputed by two or more executions, matched by plan
shape) may be worth persisting between stages. Self-flags a confidence that scales with
how many executions reuse the same relation: reuse is only inferred, from
plan-scan identity across SQL executions, so confirm the reads really do
hit the same data before you cache anything.

### `CSTOR`: Cache storage {#cstor}

A persisted dataset is not fully cached in memory, or is spilling to disk.
Raise executor memory, or shrink the cached dataset.

The cached-partition counts and sizes come from `SparkListenerBlockUpdated`
events, which Spark writes only when
`spark.eventLog.logBlockUpdates.enabled=true`. Since Spark 2.3 the RDD
storage figures in stage-submission events are always 0, and they are
used only as a fallback. When a Spark 2.3+ run persists RDDs but its log has
neither and block-update logging was off, the check reports that the cache could not be
checked instead of passing it: turn `spark.eventLog.logBlockUpdates.enabled`
on and rerun to measure eviction and disk spillover.

### `LOCAL`: Core usage locality {#local}

Tasks run without process- or node-local data placement more often than
expected. Check `spark.locality.wait` settings and executor/data colocation.
Self-flags a confidence that scales with the non-local ratio and sample
size: the thresholds are our own noise floor for this metric.

### `CHRN`: Autoscaling churn {#chrn}

Executors are stood up and torn down again before they can do useful work:
re-provisioning churn rather than normal scale-down. Raise
`spark.dynamicAllocation.executorIdleTimeout`, or widen the
`minExecutors`/`maxExecutors` bounds to reduce flapping. Self-flags a
confidence that scales with how far the short-lived-executor share sits
past the threshold: these thresholds are still a design spike, not yet
validated against real-world runs.

### `JOBS`: Job failure rate {#jobs}

A large share of completed jobs did not succeed. Inspect the driver log for
the failed job(s) and the stage failures that triggered them.

### `INCMP`: Incomplete run {#incmp}

This event log never recorded an `ApplicationEnd` event: capture stopped
before the run finished (an in-flight job, a rotated-away log, or a
cut-short capture). Every other finding and metric on the board reflects
only what was captured up to that point, not the full run.

## Configuration scope

### `CFG`: Configuration audit {#cfg}

Flags configuration settings that may cause reliability or efficiency
problems, independent of any one stage's behavior. Four checks run
today:

- `spark.shuffle.service.enabled`: flagged when dynamic allocation is on
  but the external shuffle service is off, since shuffle data won't survive
  executor removal.
- `spark.dynamicAllocation.minExecutors`/`maxExecutors`: with dynamic
  allocation on, flagged when min exceeds max (reported on `minExecutors`)
  or when no max is set.
- `spark.serializer`: flagged when not set to Kryo (the default is the Java
  serializer); `org.apache.spark.serializer.KryoSerializer` is faster and
  produces smaller buffers.
- `spark.executor.memoryOverhead`: flagged when set below max(384 MiB, 10%
  of executor memory).

## SQL scope

### `PLAN`: Plan advisor {#plan}

Flags patterns in the SQL execution plan worth reviewing. Four checks share
this tag:

- Duplicate plan subtree: the same subtree recomputed more than once in the
  plan. When the repeats have the same shape but different filters, columns
  or tables, the finding stays informational and claims no time. Only flagged
  when the repeat's stages take at least 0.5% of the run.
- Small files: one plan node reads or writes more than 100 files averaging
  under 3 MB. Compact upstream output, or coalesce before writing.
- Under-broadcast: the smaller side of a Sort Merge Join looks well under
  the broadcast threshold; consider a `broadcast()` hint or raising
  `spark.sql.autoBroadcastJoinThreshold`.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured
  `spark.sql.autoBroadcastJoinThreshold`.
