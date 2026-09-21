# Understanding findings

Every flagged problem carries a short ALL-CAPS tag. This page has one entry
per tag: what it means, and what to do about it.

A few tags share their in-app "Reference panel" background reading with
another tag, because the underlying Spark-tuning material overlaps: `SFAIL`
with `FAIL`, `PART` with `SHFL`, `SPEC` with `STRAG`, and `CACHE`/`LOCAL`
with `UTIL`.

## Per-stage

### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. For join-driven skew, enable AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`); otherwise salt the key or
repartition on a better key.

### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join.

### `SPILL`: Memory and disk spill {#spill}

Tasks are writing data out of memory, which slows execution. Two spill
patterns get flagged differently: skew spill, where a few heavy tasks spill
while most don't (rebalance partitioning), and volume spill, where most
tasks spill because the data genuinely exceeds available memory (add
partitions).

### `GC`: Garbage collection pressure {#gc}

Tasks spend an unusually large share of time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.

### `FAIL`: Failed tasks {#fail}

Tasks fail often enough to affect the stage. Failed tasks point to executor
instability or data-driven errors: check driver logs for the dominant
failure reason.

### `SFAIL`: Failed stage {#sfail}

A stage attempt failed outright rather than losing individual tasks within
it. Inspect the driver log for the failure reason and the job that triggered
it.

### `STRAG`: Straggler tasks {#strag}

A few tasks run much slower than the rest of their stage. Rule out a GC
pause or a slow shuffle fetch before assuming a hardware issue; if a skewed
key is the real cause, that's a candidate for AQE's skew-join handling.

### `SPEC`: Speculation waste {#spec}

Speculative task attempts used a lot of executor time without confirming a
genuine straggler. Self-flagged low-confidence: a design spike, not yet
validated against real-world runs. If task durations are just naturally
variable rather than genuine stragglers, tune
`spark.speculation.multiplier`/`spark.speculation.quantile`.

### `RETRY`: Retry waste {#retry}

Repeated task attempts ate into execution time even though the stage
completed. Investigate executor loss or fetch failures.

### `TINY`: Tiny tasks {#tiny}

Many very short tasks add scheduling overhead out of proportion to the work
each one does. Repartition to fewer, larger tasks.

### `PART`: Partition sizing {#part}

Shuffle partitions are too large, too uneven, or too few for the work. A
single shuffle partition over 5 GB, for example, will OOM or spill heavily:
repartition to break it up before the stage runs.

### `SLOW`: Stage slowness {#slow}

A stage ran long overall without a more specific cause getting flagged.
Often a partition-count problem: raise parallelism via
`spark.sql.shuffle.partitions` or `spark.default.parallelism`, or check for a
large per-task data volume driving heavy shuffle and spill.

### `SHAPE`: Stage shape {#shape}

The stage has an inefficient task count, output shape, or task-to-stage
balance: for example, one straggler task taking a large fraction of the
stage's wall-clock time.

### `HOST`: Slow host {#host}

One executor is much slower than its peers. It may just hold data locality
for its tasks or carry one heavy stage, rather than a hardware fault.
Enable `spark.speculation` to relaunch a lagging task automatically.

## App-level

### `COLD`: Executor cold start {#cold}

New executors take time to become available for work. Pre-warm the cluster,
or use dynamic allocation.

### `UTIL`: Low utilization {#util}

Allocated executors sit idle for a large share of the application run.
Consider a smaller cluster, or enable dynamic allocation.

### `MEM`: Memory utilization {#mem}

Executor memory or core capacity may be over- or under-provisioned. Some
detail here needs `spark.eventLog.logStageExecutorMetrics=true` on the run
being analyzed; without it, per-executor memory usage can't be broken down.
Review `spark.executor.memory` and executor count if allocated memory sat
largely idle over the run. That idle-memory variant is self-flagged
low-confidence: it estimates waste from allocated-versus-used memory-time
against an unverified 1.5x buffer. Check it against
the Spark UI before resizing anything.

### `CACHE`: Caching opportunity {#cache}

A reusable dataset (re-read via the same SQL relation more than once) may be
worth persisting between stages. Self-flagged low-confidence: reuse is only
inferred, from plan-scan identity across SQL executions, so confirm the reads
really do hit the same data before you cache anything.

### `CSTOR`: Cache storage {#cstor}

A persisted dataset is not fully cached in memory, or is spilling to disk.
Raise executor memory, or shrink the cached dataset.

### `LOCAL`: Core usage locality {#local}

Tasks run without process- or node-local data placement more often than
expected. Check `spark.locality.wait` settings and executor/data colocation.
Self-flagged low-confidence: the non-local-ratio thresholds are unvalidated
design-spike values, and no external tool publishes an equivalent metric to
calibrate them against.

### `CHRN`: Autoscaling churn {#chrn}

Executors are stood up and torn down again before they can do useful work:
re-provisioning churn rather than normal scale-down. Raise
`spark.dynamicAllocation.executorIdleTimeout`, or widen the
`minExecutors`/`maxExecutors` bounds to reduce flapping. Self-flagged
low-confidence: a design spike, not yet validated against real-world runs.

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
problems, independent of any one stage's behavior. Four properties are
audited today:

- `spark.shuffle.service.enabled`: flagged when dynamic allocation is on
  but the external shuffle service is off, since shuffle data won't survive
  executor removal.
- `spark.dynamicAllocation.maxExecutors`: flagged for inverted bounds or a
  missing upper bound.
- `spark.serializer`: flagged when still on the default Java serializer;
  `org.apache.spark.serializer.KryoSerializer` is faster and produces
  smaller buffers.
- `spark.executor.memoryOverhead`: flagged when set below a safe floor.

## SQL scope

### `PLAN`: Plan advisor {#plan}

Flags patterns in the SQL execution plan worth reviewing. Four checks share
this tag:

- Duplicate plan subtree: the same subtree recomputed more than once in the
  plan.
- Small files: reading an excessive number of small files.
- Under-broadcast: the smaller side of a Sort Merge Join looks well under
  the broadcast threshold; consider a `broadcast()` hint or raising
  `spark.sql.autoBroadcastJoinThreshold`.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured
  `spark.sql.autoBroadcastJoinThreshold`.
