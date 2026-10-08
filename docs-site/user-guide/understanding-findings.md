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

Skew is a statement about data volume, as in Spark's UI and AQE. Each stage's
slow tasks (over 3x the median task) are compared with the median task's input
plus shuffle-read bytes and records. If run time scaled with that volume, the
share of the slow tasks' extra time it accounts for is the data share; at 50% or
more the tail is skew (`evidence.cause` is `data`, `evidence.dataRatio` is the
median slow task's volume over the median task's). A tail that mostly is not data
is reported as `STRAG` with its cause. Ratios take the median task's volume or a floor
of 1 MiB and 1,000 records, whichever is larger, so a median of a few bytes never prints
a huge multiple. When the median task read nothing, there is no ratio to take
(`evidence.dataRatio` is absent): GC and fetch wait claim their share of the slow
tasks' extra time first, and a slow task that read data (at least 1 MiB or 1,000
records) owns what is left. When the data share is under 50%, the cause is the largest
of GC, fetch wait, host and what none of them accounts for. With no data volume
to compare, what none of them accounts for is labelled `unattributed` (no share is
reported) instead of `unexplained`; GC, fetch wait or host still win when larger. A
stage with no tail attribution is `unattributed` too. For `unattributed` both
findings keep the duration test, the `SKEW` advice says nothing in the log attributes
the tail to data, and the Findings board lists the pair on one stage once, under the
finding with the larger recoverable time.

With AQE skew-join handling on, a `shuffleJoin` stage's advice says why
handling did or did not act on that stage's join, read from the execution's
final plan and its effective conf. `evidence.aqeSkew` records the case:

| `aqeSkew` | What the final plan and conf show | Advice |
|---|---|---|
| `split` | The join is marked `skew=true` and a shuffle read says `skewed` | AQE already split the skewed partitions, so what remains is not join skew: look at GC, a slow host or an expensive key. When the tail is data (`evidence.cause` is `data`), the slow tasks still read far more data than the median task, and the advice is the key remedy. |
| `evenReads` | One join side shuffles next to nothing, so the task read is the other side's, and the largest task read is under twice the median | The slow tail is not partition-size skew: look at GC, a slow host or an expensive key. Never given when `evidence.cause` is `data`, which counts input and records as well as shuffle-read bytes. |
| `belowThreshold` | The largest task read is under `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` (256 MB by default), which bounds every partition of both sides; or one side's read is at least twice the median but not far enough over it for `spark.sql.adaptive.skewJoin.skewedPartitionFactor` (5) | Lower the threshold or the factor for the query. |
| `planShape` | An aggregate, window or other operator sits between the join and its shuffle | AQE splits only a shuffle that feeds the join directly: salt the key. |
| `userRepartition` | The shuffle under the join is a `repartition` or `rebalance` in the job's code | AQE leaves a shuffle you asked for alone: drop it, or salt the key. |
| `joinType` | The join type does not let AQE split the skewed side: neither side of a full outer join, only the left side of a left outer, left semi or left anti join, only the right side of a right outer join | Join the hot key on its own and union the results, or salt the key. Swapping the sides does not help: the null-supplying or filtering table stays unsplittable. |
| `extraShuffle` | An aggregate, window or join above this join needs its partitioning, so a split would add a shuffle | Set `spark.sql.adaptive.forceOptimizeSkewedJoin` to `true` when that shuffle costs less than the tail (Spark 3.3 and later; before that, salt the key). |
| `notSplit` | Nothing above explains it | Salt the key. |

The stage's join is the one whose plan node ran in that stage; a plan whose
nodes carry no stage ids is read as one join only when the stage's shuffle read
matches what the join's two shuffles wrote. A task reads one partition of each
join side, so the stage's largest task read covers both sides. Spark judges each
side's partitions against that side's own median, which the log does not give, so
the finding calls the reads even or under the factor only when one side shuffles
at most 5% of the join's bytes; otherwise it can only show a partition is under
the absolute threshold (a task's read bounds every partition in it). The finding
does not say which side is skewed; for a join type that splits only one side it
names both possibilities. A run whose final plan is missing or ties no join to
the stage, or whose coalesced read could be many small partitions, keeps the
general advice.

### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join. The partition-count
advice follows the effective conf (`evidence.partitions`): `raise` when the
property limits the stage, `sufficient` when the tasks already read a good
size each, `aqeCoalesced` when AQE merged the partitions of a stage in a SQL
execution (lower `spark.sql.adaptive.advisoryPartitionSizeInBytes`), and
`ownPartitioning` when the property is already high enough (the stage's own
`repartition(n)` or RDD parallelism limits it, as for any stage outside a SQL
execution). With AQE coalescing on,
`spark.sql.adaptive.coalescePartitions.initialPartitionNum` replaces the
property as the starting count when it is set, and a stage that ran more tasks
than that, with a skew split in the final plan or no final plan to rule one
out, is not blamed on its own `repartition(n)`. Only flagged on stages that
take at least 0.5% of the run.

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
When the log carries no measured executor heap peaks, or the executor memory
is unknown, so [`MEM`](#mem) cannot judge the heap, a stage with GC below 5%
gets an informational note that executor memory may be over-provisioned, only
on stages that take at least 0.5% of the run. Both need at least 10 s of
executor run time on the stage. A run with any advice to raise executor memory
(high GC, volume spill, a GC-bound straggler tail) gets no advice to lower it.

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

A few tasks run much slower than the rest of their stage for a reason other
than reading more data (a data-driven tail is `SKEW`). `evidence.cause` names
what the slow tasks' extra time went to, taken in this order so no millisecond
counts twice: data volume, then GC time over the median task's, then shuffle
fetch wait over the median task's, then one host that holds most of the slow
tasks out of proportion to its share of the stage (`evidence.host`). What none of
them accounts for is `unexplained` (`unattributed` with no data volume to compare); `evidence.cpuPct` (the slow tasks' CPU time
over their run time) says whether those tasks mostly waited or were busy. With
no data volume to compare, what is left is `unattributed` when it is the largest share, and the advice is the one a
skew finding gives for the same stage (`evidence.origin` and `evidence.aqeSkew`, see `SKEW`).
A stage is flagged when more than 5% of its tasks run over 4x the median (2.5%
when the tail clears 0.5% of the run; a finding reached through `SKEW`'s
duration test reports the share over 3x the median instead), a speculative task ran, or the `SKEW`
duration test holds on a tail that is not data. A stage whose tail is data but
which `SKEW` does not flag by duration keeps a `STRAG` finding with cause `data`.
Stages under 0.5% of the run are skipped unless the `SKEW` duration test holds.

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
`defaultParallelism` tasks) and then raise the advisory size, which alone changes
nothing while `parallelismFirst` is on; otherwise lower the
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
is `off`, which includes a run that never set it, as Spark defaults it off) no
executor-count property applies and `remediation` is empty.

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
memory risk. A log with no peaks (every task ended between two heartbeats, so
each reports zeros, as in local mode) gets a note that executor memory sizing was
not measured; it suggests `spark.eventLog.logStageExecutorMetrics=true` while that
is off. The advice to lower executor memory (a heap under 70%, idle allocated
memory-time, or low GC) is dropped when anything in the run asks for more. The
idle-memory figure counts the executors' alive time, not the peak executor count
over the whole run.
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
  flagged when the effective max is Spark's unbounded default, so the cluster
  can grow without a cap.
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

Flags patterns in the SQL execution plan worth reviewing. Six checks share
this tag:

- Duplicate plan subtree: the same subtree recomputed more than once in the
  plan. When the repeats have the same shape but different filters, columns
  or tables, the finding stays informational and claims no time. Only flagged
  when the repeat's stages take at least 0.5% of the run.
- Small files: one plan node reads or writes more than 100 files averaging
  under 3 MB. Compact upstream output, or coalesce before writing.
- Nested loop join: a `BroadcastNestedLoopJoin` or `CartesianProduct` whose
  output has at least 1,000,000 rows (the rows a `CartesianProduct`'s condition
  kept, when it has one). A `BroadcastNestedLoopJoin` must also
  produce at least 10 times the rows of its larger input; a `CartesianProduct`
  is judged on its output alone, because it re-reads each input once per
  partition of the other side, so the input row counts the executors report
  are not row counts. Spark plans these when a join has no equi-join key. The
  finding carries the join condition and is graded by the time of the stages
  that run the join. The advice is to add an equi-join key, to bucket the range
  of a range join and join on the bucket, or to confirm that a cross join is
  intended. It needs the executors' `number of output rows` metrics, so a join
  with no reported row counts is not flagged.
- Row-at-a-time Python UDF: a plan runs `BatchEvalPython`, which pickles
  every row to a Python worker and back. Flagged when its stages sent at
  least 64 MiB to the workers (`data sent to Python workers`) and ran for at
  least 30 seconds together; the finding reports the bytes sent and returned
  and the stage time, and is informational. `ArrowEvalPython` (Arrow-optimized
  and pandas UDFs) is never flagged. The advice is
  `spark.sql.execution.pythonUDF.arrow.enabled=true` (Spark 3.4 and later;
  already the default from 4.2, where the UDF may have opted out with
  `useArrow=False`, take no arguments, or have been created before the property
  was set) or a pandas UDF. These floors are conservative guesses,
  not tuned against real workloads. A plan that reports no
  `data sent to Python workers` value is skipped.
- Under-broadcast: a side of a Sort Merge Join that its join type can
  broadcast (`evidence.buildSide`, sized by the finding's value) was not
  broadcast although it is small enough: it is over a small effective
  threshold (`evidence.broadcastThreshold` is `limits`), or automatic
  broadcast is disabled with `-1` (`disabled`); consider a `broadcast()` hint
  or setting the threshold property. The size is
  the shuffle's `data size`, the metric adaptive execution compares at runtime.
  The threshold is `spark.sql.adaptive.autoBroadcastJoinThreshold` when the
  plan is adaptive and that property is set, else
  `spark.sql.autoBroadcastJoinThreshold` (the query's own setting, else the
  logged one, else Spark's 10 MiB). A full outer join never fires, and a side
  under 1 MiB or over the over-broadcast limit is skipped. When the effective
  threshold already admits the side (`evidence.broadcastThreshold` is
  `notLimiting`), the threshold is not what stopped the broadcast, so
  `remediation` is empty and the advice is a hint or table statistics (for an
  adaptive plan, `spark.sql.adaptive.nonEmptyPartitionRatioForBroadcastJoin`:
  AQE keeps a side with a low share of non-empty partitions out of a broadcast
  whatever its size). Both
  sides need a shuffle `data size` of their own, so a join over another join's
  output is skipped, and so is a join whose only buildable side is larger than
  the other side, since broadcasting it saves nothing. The build side is
  always the smaller one and `evidence.largerSideBytes` is the other side.
- Over-broadcast: a broadcast exceeds the 1 GB threshold; check for a
  misapplied broadcast hint or a misconfigured threshold property. Under
  adaptive execution a broadcast planned up front is admitted by
  `spark.sql.autoBroadcastJoinThreshold` and one converted at runtime by
  `spark.sql.adaptive.autoBroadcastJoinThreshold` (when set), so the finding
  names whichever of them admits the broadcast. When every applicable
  threshold is below the broadcast or disabled (`evidence.broadcastThreshold`
  is `notLimiting`, or `disabled` when all are disabled), a hint forced it:
  remove the hint, and `remediation` is empty.
