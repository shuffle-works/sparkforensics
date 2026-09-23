# Shuffle I/O

<span class="tag">SHFL</span>

## What it is

Shuffle I/O is the data movement Spark performs between stages whenever an operation needs
to redistribute data across the cluster so that related rows land on the same partition.
At the DataFrame/SQL level, `groupBy()`, `join()`, `agg()`, `sortBy()`, and `reduceByKey()`-style
aggregations are the classic wide transformations that force this exchange[^1]. Non-broadcast
join strategies (shuffle hash join, shuffle sort-merge join, and shuffle-and-replicated nested
loop / Cartesian product join) all shuffle data across executors the same
way[^1]. At the RDD layer, the operations that can cause a shuffle are repartitioning
(`repartition`, `coalesce`), `'ByKey` operations other than counting (`groupByKey`,
`reduceByKey`), and join-family operations (`cogroup`, `join`)[^2].

Spark can skip the shuffle when it already knows the data layout: Storage Partition Join
avoids it entirely when Spark can use partitioning already reported by a compatible V2 data
source[^3], and classic Hive-style bucketing has the same effect: once both sides of a join
are bucketed and sorted the same way, the physical plan shows no `Exchange` operator[^4].
`DataFrameWriter.partitionBy`, by contrast, does not trigger a shuffle by itself on write[^5].

At the metrics level, shuffle reads split cross-node traffic from same-host traffic:
`remoteBytesRead` counts bytes read from a remote executor, `localBytesRead` counts bytes
read from local disk, and `totalBytesRead` is their sum[^6].

## How it's detected

| Signal | Fires when |
|---|---|
| Shuffle read bytes in a stage | > 50 MB |

50 MB marks a stage as shuffle-heavy enough to flag. Severity then tracks the estimated
recoverable time as a share of the app's total runtime: ≥2% is critical, ≥0.5% is
warning, anything smaller is info.

Beyond raw byte volume, the executor-side wait is captured by `fetchWaitTime`: time a task
spends blocked on a remote shuffle block it needs next, not counting time spent prefetching
other blocks in the background[^6]. That wait time counts toward the task's overall
`executorRunTime`, since Spark's wall-clock task-time metric explicitly includes time
fetching shuffle data[^6].

## Why it matters

As shuffle volume grows, the underlying pull-based mechanism gets less efficient: the number
of shuffle blocks grows quadratically with mapper × reducer count while individual block
sizes shrink to only tens of KB, which is inefficient for disk-backed random reads[^7].
Because fetch-wait time is part of a task's measured execution window, that inefficiency
shows up directly as added task time rather than as separate, hidden overhead[^6].

## How to fix it

- Let [Adaptive Query Execution](#aqe) coalesce small post-shuffle partitions automatically at
  runtime (`spark.sql.adaptive.coalescePartitions.enabled`, default `true`) instead of only
  hand-tuning a fixed partition count[^3].
- Review `spark.sql.shuffle.partitions` (default `200`), which applies uniformly to every
  `join()`, `groupBy()`, and aggregation regardless of how much data is actually moving[^8].
  There's no fixed formula for the right value: pull it down toward the executor core
  count for small or streaming workloads[^1], and otherwise favor over- to
  under-provisioning, since Spark's low per-task overhead makes it safer to have too many
  tasks than too few[^9].
- Where possible, avoid the shuffle altogether: bucket both sides of a join identically, or
  rely on Storage Partition Join for compatible sources, so the physical plan drops the
  `Exchange` node[^3][^4].
- If map tasks are I/O-bound writing many shuffle files, increase
  `spark.shuffle.file.buffer` (default `32k`) to reduce disk seeks and system calls on the
  write side[^8]; Learning Spark's tuning table recommends bumping it to 1 MB for large
  jobs[^1].
- If executors have memory to spare, increase `spark.reducer.maxSizeInFlight` (default
  `48m`) so reducers can pull more map output concurrently and need fewer fetch rounds[^8].
- At larger scale, enable the external shuffle service (effectively required for [dynamic
  allocation](#cluster-config), since it lets shuffle files be served after an executor is removed[^10]) and
  consider push-based (Magnet) shuffle, which converts many small random reads into large
  sequential reads of pre-merged chunks[^7].

> **PySpark:** adjust the shuffle partition count directly from a running session with
> `spark.conf.set("spark.sql.shuffle.partitions", 100)`.

A shuffle-tuning starting point: defaults shown, comments say which way to move:

```properties
# Let AQE coalesce small post-shuffle partitions at runtime
spark.sql.adaptive.enabled=true
spark.sql.adaptive.coalescePartitions.enabled=true

# Baseline shuffle partition count (default 200); pull toward executor-core count for small jobs
spark.sql.shuffle.partitions=200

# Reduce write-side disk seeks on large shuffles (default 32k; Learning Spark suggests 1m)
spark.shuffle.file.buffer=1m

# Let reducers pull more map output per fetch round when executors have spare memory (default 48m)
spark.reducer.maxSizeInFlight=48m
```

## Partition sizing {#bottleneck-partition-sizing}

<span class="tag">PART</span>

### How it's detected

A stage's shuffle-read partition sizes surface three distinct problems:

| Signal | Fires when | Level |
|---|---|---|
| Largest partition vs. median | > 5× the median **and** > 256 MB | Warning |
| Low parallelism | ≥ 1 GB of shuffle read spread across ≤ 7 tasks | Warning |
| Oversized partition | Largest partition ≥ 5 GB | Critical |

Skew and low-parallelism severity track the estimated recoverable time as a share of the
app's total runtime, the same wall-clock model used across this reference. An oversized
partition is a fixed safety signal instead: it reports critical purely on its own size,
because a partition past 5 GB is an OOM/crash risk regardless of how much wall-clock time
fixing it would recover, so it stays critical even on a stage that barely dents the run.

Adaptive Query Execution re-optimizes the plan while the query runs: as each shuffle stage
materializes, it reads the real shuffle-file sizes and resizes partitions before launching the
stages downstream[^11]. That runtime feedback is what corrects a partition grid that static
estimates would get wrong.

The coarse starting grid is `spark.sql.shuffle.partitions` (default `200`), the fixed partition
count Spark uses when shuffling for joins or aggregations[^14]. A single number cannot fit every
stage. Spread a few megabytes across 200 partitions and most cores sit idle on a handful of rows
each; push hundreds of gigabytes through the same 200 and every executor is overloaded, often into
memory errors. For small or streaming workloads the 200 default is usually too high, and pulling it
toward the executor-core count thins out the flood of tiny partitions crossing the network[^1]. The
pattern AQE encourages is the opposite of hand-tuning that number: leave the initial count large and
let runtime coalescing combine adjacent small partitions instead[^11].

**Partitions too small (low parallelism payoff).** `spark.sql.adaptive.coalescePartitions.enabled`
(default `true`) merges contiguous shuffle partitions up to a target size so a stage does not end up
with many tiny tasks[^12]. The target is `spark.sql.adaptive.advisoryPartitionSizeInBytes`, the
advisory shuffle-partition size AQE steers toward during adaptive optimization, default `64 MB`[^12].

**Partitions too big or skewed.** `spark.sql.adaptive.skewJoin.enabled` (default `true`) handles
skew in shuffled joins by splitting the oversized partitions and replicating the matching side where
needed[^13]. A partition only counts as skewed when it clears both bars: larger than
`spark.sql.adaptive.skewJoin.skewedPartitionFactor` (default `5.0`) times the median partition size,
and larger than `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` (default `256 MB`)[^13].
Once it qualifies, the partition is split back down toward the advisory size.

So the two knobs divide the labor: `spark.sql.shuffle.partitions` lays down the coarse initial grid,
and `advisoryPartitionSizeInBytes` (64 MB) is the size AQE aims each partition at from both
directions. Partitions below it get coalesced; skewed partitions past the 256 MB / 5.0-factor bar get
split toward it.

## Limitations / false-positive risk

A high shuffle-byte count is not automatically a defect. A wide transformation such as a large
`join()` or `groupBy()` legitimately has to move that data, so the volume can be an inherent property
of the query rather than something worth fixing. The byte thresholds that raise Info, Warning, and
Critical levels are heuristic cutoffs, not measured limits for a given cluster, so treat them as a
prompt to look rather than a verdict.


## Related

- **The mechanism:** [Shuffle](#shuffle)
- **Tuning parallelism:** [Partitioning](#partitioning)

[^1]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das, Lee, ch. 7
[^2]: [RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
[^3]: [Performance Tuning (Spark SQL, DataFrames and Datasets Guide)](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^4]: [Bucketing (The Internals of Spark SQL)](https://books.japila.pl/spark-sql-internals/bucketing/)
[^5]: [Spark Tips: Partition Tuning](https://luminousmen.com/post/spark-tips-partition-tuning)
[^6]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
[^7]: [SPARK-30602: Support push-based shuffle to improve shuffle efficiency](https://issues.apache.org/jira/browse/SPARK-30602)
[^8]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^9]: [How to Tune Your Apache Spark Jobs (Part 2): Cloudera Engineering Blog](https://blog.cloudera.com/how-to-tune-your-apache-spark-jobs-part-2/)
[^10]: [Job Scheduling: Dynamic Resource Allocation](https://spark.apache.org/docs/latest/job-scheduling.html)
[^11]: [Adaptive Query Execution: Speeding Up Spark SQL at Runtime (Databricks)](https://www.databricks.com/blog/2020/05/29/adaptive-query-execution-speeding-up-spark-sql-at-runtime.html)
[^12]: [Performance Tuning: Coalescing Post Shuffle Partitions](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^13]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^14]: [SQLConf: shuffle-partition defaults (Spark source)](https://raw.githubusercontent.com/apache/spark/v3.5.0/sql/catalyst/src/main/scala/org/apache/spark/sql/internal/SQLConf.scala)
