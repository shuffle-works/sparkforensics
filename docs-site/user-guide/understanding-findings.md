# Understanding findings

Every flagged problem carries a short ALL-CAPS tag. This page has one entry
per tag: what it means, and what to do about it.

Each tag links to the matching section of the Spark
[tuning reference](../tuning-reference/index.md), opened in an in-app **Reference**
panel next to the board. `INCMP` has no reference section, so its tag opens
this page instead. Turn on [Advanced view](./getting-started/reading-the-dashboard.md#advanced-view)
to also see a finding's confidence when it is below high, and a page icon
beside the tag that opens this page's entry. Some tags point into another
tag's reference page because the material overlaps: `SFAIL` shares `FAIL`'s
section; `PART` is on the `SHFL` page, `SPEC` on `STRAG`, `SHAPE` on `SKEW`,
`SLOW` on `HOST`, and `CACHE`/`LOCAL` on `UTIL`.

## Per-stage

### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. The fix depends on what the stage reads, which the finding's
`evidence.origin` records. A stage that reads a shuffle feeding a join
(`shuffleJoin`) gets AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`), unless the run's effective conf
already has it; otherwise salt the key or repartition on a better key. A
stage that reads files with uneven sizes (`inputScan`) gets compaction of
small files or a lower `spark.sql.files.maxPartitionBytes`. Any other stage
(`other`) gets the salting advice and no conf, as a `code` entry in
`remediation`. Flagged when P95 task time
(the longest task, on a stage with fewer than 20 tasks) exceeds 3x the median
and the recoverable tail is at least 0.5% of the run. The median is the
textbook one: on an even task count, the mean of the two middle values.

With AQE skew-join handling on, a `shuffleJoin` stage's advice says why
handling did or did not act on that stage's join, read from the execution's
final plan and its effective conf. `evidence.aqeSkew` records the case:

| `aqeSkew` | What the final plan and conf show | Advice |
|---|---|---|
| `split` | The join is marked `skew=true` and a shuffle read says `skewed` | AQE already split the skewed partitions, so what remains is not join skew: look at GC, a slow host or an expensive key. |
| `belowThreshold` | The largest partition is under `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` (256 MB by default), or not far enough over the median for `spark.sql.adaptive.skewJoin.skewedPartitionFactor` (5) | Lower the threshold or the factor for the query. |
| `planShape` | An aggregate, window or other operator sits between the join and its shuffle | AQE splits only a shuffle that feeds the join directly: salt the key. |
| `userRepartition` | The shuffle under the join is a `repartition` or `rebalance` in the job's code | AQE leaves a shuffle you asked for alone: drop it, or salt the key. |
| `joinType` | The join type does not let AQE split the skewed side: neither side of a full outer join, only the left side of a left outer, left semi or left anti join, only the right side of a right outer join | Put the skewed table on a splittable side, or salt the key. |
| `extraShuffle` | An aggregate, window or join above this join needs its partitioning, so a split would add a shuffle | Set `spark.sql.adaptive.forceOptimizeSkewedJoin` to `true` when that shuffle costs less than the tail. |
| `notSplit` | Nothing above explains it | Salt the key. |

The stage's join is the one whose plan node ran in that stage. The partition
size is the stage's largest task read, which covers both sides of the join,
so the finding does not say which side is skewed; for a join type that splits
only one side it names both possibilities. A stage whose plan lists joins for
other stages only reads an aggregate's or window's shuffle (`origin` is
`other`). A run whose final plan is missing, or whose coalesced read could be
many small partitions, keeps the general advice.

### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join. The partition-count
advice follows the effective conf (`evidence.partitions`): `raise` when the
property limits the stage, `sufficient` when the tasks already read a good
size each, `aqeCoalesced` when AQE merged the partitions (lower
`spark.sql.adaptive.advisoryPartitionSizeInBytes`), and `ownPartitioning` when
the property is already high enough (the stage's own `repartition(n)` or RDD
parallelism limits it). Only flagged on stages that take at least 0.5% of the
run.

### `SPILL`: Memory and disk spill {#spill}

Tasks are writing data out of memory, which slows execution. Two spill
patterns get flagged differently: skew spill, where a few heavy tasks spill
while most don't (rebalance partitioning), and volume spill, where most
tasks spill because the data genuinely exceeds available memory (add
partitions or executor memory). Partition-count advice is given only for a
stage that reads a shuffle; `evidence.reads` says what the stage reads
(`shuffle`, `input` or `other`). It names what sized the stage:
`spark.sql.shuffle.partitions` when the stage ran that many tasks,
`spark.sql.adaptive.advisoryPartitionSizeInBytes` when AQE coalesced them, and
the stage's own `repartition(n)` or RDD parallelism otherwise. Only flagged on stages that take at
least 0.5% of the run.

### `GC`: Garbage collection pressure {#gc}

Tasks spend more than 10% of executor run time reclaiming memory. Reduce
object creation: use primitive types, avoid UDFs, or raise executor memory.
When the log carries no measured executor heap peaks (see [`MEM`](#mem)), a
stage with GC below 5% gets an informational note that executor memory may be
over-provisioned, only on stages that take at least 0.5% of the run. Both need
at least 10 s of executor run time on the stage.

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
it. With redaction on, the failure reason becomes `[redacted]`, since it can
carry file paths and data values.

### `STRAG`: Straggler tasks {#strag}

A few tasks run much slower than the rest of their stage. Rule out a GC
pause or a slow shuffle fetch before assuming a hardware issue. If uneven
data is the cause, the advice is the one a skew finding gives for the same
stage (`evidence.origin` and `evidence.aqeSkew`, see `SKEW`): the reason AQE
skew-join handling did or did not act for a shuffle feeding a join, file sizes
for a scan, salting otherwise. Only flagged on
stages that take at least 0.5% of the run.

### `SPEC`: Speculation waste {#spec}

Speculative task attempts used a lot of executor time without confirming a
genuine straggler. Self-flags a confidence that scales with how far the
wasted time sits past the threshold. If task durations are just naturally
variable rather than genuine stragglers, tune
`spark.speculation.multiplier`/`spark.speculation.quantile`. The
recommendation names the run's effective values: Spark relaunches a task that
runs over the multiplier times the median once the quantile of the stage's
tasks has finished, which is 1.5x and 75% before Spark 4.0 and 3x and 90% from
4.0 unless the job sets them. A speculative-attempt `straggler` and a
`slowHost` finding word their speculation advice the same way.

### `RETRY`: Retry waste {#retry}

Repeated task attempts ate into execution time even though the stage
completed. Investigate executor loss or fetch failures.

### `TINY`: Tiny tasks {#tiny}

Many very short tasks add scheduling overhead out of proportion to the work
each one does. Repartition to fewer, larger tasks. On a stage that reads a
shuffle (`evidence.reads` is `shuffle`) the advice names what sized it: lower
`spark.sql.shuffle.partitions` when the stage ran that many tasks; when AQE
coalesced them and still kept tiny ones, set
`spark.sql.adaptive.coalescePartitions.parallelismFirst` to `false` (AQE then
targets `spark.sql.adaptive.advisoryPartitionSizeInBytes` rather than
`defaultParallelism` tasks) or raise the advisory size; otherwise lower the
`repartition(n)` or RDD partition count in the code. Only flagged on stages that take at least 0.5% of the run.

### `PART`: Partition sizing {#part}

Shuffle partitions are too large, too uneven, or too few for the work. A
single shuffle partition over 5 GB, for example, will OOM or spill heavily:
repartition to break it up before the stage runs. The partition-skew rule
words its advice the same way a `SKEW` finding does, including
`evidence.aqeSkew`.

### `SLOW`: Stage slowness {#slow}

A stage ran for 15 minutes or more and no slow host was flagged on it. It
can appear alongside other findings on the same stage. On a stage that reads a
shuffle, often a partition-count problem: raise `spark.sql.shuffle.partitions`
when the stage ran that many tasks, lower
`spark.sql.adaptive.advisoryPartitionSizeInBytes` when AQE coalesced them, or
raise the stage's own `repartition(n)` or RDD parallelism; or check for a
large per-task data volume driving heavy shuffle and spill. On a stage that
reads input files and no shuffle, check input file sizes and lower
`spark.sql.files.maxPartitionBytes`. `evidence.reads` says which case
applied (`shuffle`, `input` or `other`).

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
scale up from zero. With dynamic allocation off (`evidence.dynamicAllocation`
is `off`) no executor-count property applies and `remediation` is empty.

### `UTIL`: Low utilization {#util}

Allocated executors sit idle for a large share of the application run: under
60% of the core time the run allocated (cores times the time each executor was
alive) ran a task. Consider a smaller cluster. With dynamic allocation off,
either lower `spark.executor.instances` or enable dynamic allocation; the two are
alternatives. With it on, lower `spark.dynamicAllocation.maxExecutors`, and
`spark.dynamicAllocation.minExecutors` too when the run sets it above 0.

### `MEM`: Memory utilization {#mem}

Executor memory or core capacity may be over- or under-provisioned: more
than 50% of allocated core time ran no task, or the busiest executor's heap
peak stayed below 70% of `spark.executor.memory`. Heap peaks come from the
executor metrics Spark 3+ writes on every task end (and from stage executor
metrics when `spark.eventLog.logStageExecutorMetrics=true`). Spark samples them
at executor heartbeat, so a peak is a lower bound, and the heap-used metric
counts uncollected garbage, so a peak near the limit is not reported as a
memory risk. A log with no peaks (Spark before 3.0, or local mode, which
reports zeros) gets a note that executor memory sizing was not measured.
Review `spark.executor.memory` and executor count if allocated memory sat
largely idle over the run. That idle-memory variant self-flags a confidence
that scales with how far the estimated waste sits past a 1.5x buffer: it
estimates waste from allocated memory-time versus task run time per
executor core (not measured heap usage). Check it against
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
expected. Check executor/data colocation.
Self-flags a confidence that scales with the non-local ratio and sample
size: the thresholds are our own noise floor for this metric.

### `CHRN`: Autoscaling churn {#chrn}

Executors are stood up and torn down again before they can do useful work:
re-provisioning churn rather than normal scale-down. Raise
`spark.dynamicAllocation.executorIdleTimeout`, or widen the
`minExecutors`/`maxExecutors` bounds to reduce flapping. With dynamic
allocation off (`evidence.dynamicAllocation` is `off`) none of those applies:
the churn is executor loss or preemption, and `remediation` is empty. Self-flags a
confidence that scales with how far the short-lived-executor share sits
past the threshold.

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
problems, independent of any one stage's behavior. Three checks run:

- `spark.dynamicAllocation.maxExecutors`: with dynamic allocation on,
  flagged when no max is set, so the cluster can grow without a cap.
- `spark.serializer`: flagged when not set to Kryo (the default is the Java
  serializer), and only on a run with stages outside any SQL execution.
  DataFrame and SQL shuffles and caches use Spark's own row format, so the
  serializer only matters for RDD work.
  `org.apache.spark.serializer.KryoSerializer` is faster and produces smaller
  buffers.
- `spark.executor.memoryOverhead`: flagged when set below the overhead Spark
  computes by default, max(`spark.executor.minMemoryOverhead`, executor memory
  times `spark.executor.memoryOverheadFactor`). The minimum is 384 MiB and the
  factor 10% unless the run sets them; each setting counts only on a Spark
  version that reads it (the factor from 3.3, the minimum from 4.0).

Two settings are never flagged because Spark rejects them at startup, so no
event log carries them: dynamic allocation with neither the external shuffle
service, shuffle tracking, shuffle-block decommissioning nor a reliable
shuffle storage plugin, and `minExecutors` above `maxExecutors`.

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
  `spark.sql.autoBroadcastJoinThreshold`. When the effective threshold
  (the query's own setting, else the logged one, else Spark's 10 MiB) already admits the smaller side
  (`evidence.broadcastThreshold` is `notLimiting`), the threshold is not what
  stopped the broadcast, so `remediation` is empty and the advice is a hint or
  table statistics.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured
  `spark.sql.autoBroadcastJoinThreshold`. When the effective threshold is
  below the broadcast or auto-broadcast is disabled (`evidence.broadcastThreshold`
  is `notLimiting` or `disabled`), a hint forced it: remove the hint, and
  `remediation` is empty.
