# Stragglers

<span class="tag">STRAG</span>

## What it is

A straggler is one task (or a small handful of tasks) that runs far longer than the rest of
the tasks in its stage, even when the stage is otherwise healthy. Because a stage only
completes once its last task finishes, a single straggler holds up the whole stage, and every
other executor sits idle waiting for it to catch up.

## How it's detected

A task counts as a straggler when speculative tasks fired for it, or when more than 5% of the
tasks in a stage run at least 4× the stage's median task duration; this rule only applies once
a stage has at least 10 tasks.

"Duration" here is `executorRunTime`: elapsed wall-clock time, not CPU time, and it already
includes any time the task spent blocked fetching shuffle data[^1]. That matters when tracking
down why a task is slow: a long `executorRunTime` doesn't necessarily mean more compute
happened. A [garbage-collection pause](#bottleneck-gc) is counted inside it rather than added on top
(`jvmGCTime` is a subset of `executorRunTime`, not additive[^1]), and a task waiting on a
remote shuffle block it needs next shows up in `shuffleReadMetrics.fetchWaitTime`, which only
counts genuine blocking time, not blocks being prefetched in the background[^1].

The "speculative tasks fired" half of the rule is Spark's own detector: once
`spark.speculation.quantile` (default `0.9`) of a stage's tasks finish, Spark compares each
remaining task's duration against `spark.speculation.multiplier` (default `3`) times the
median of the tasks that already finished, subject to a `spark.speculation.minTaskRuntime`
floor (default `100ms`) so short tasks aren't flagged just for being slower than a tiny
median[^2]. Speculation itself is off by default (`spark.speculation` defaults to `false`), so
this half of the rule only fires on stages where it's been turned on[^2].

Watch for overlap with [task skew](#bottleneck-skew): an unevenly distributed key sends one
partition far more data than its peers, and that partition's task will trip this same duration
threshold even though the underlying cause is data volume, not a slow host or a GC pause.
Check the skew signals before assuming the latter.

## Why it matters

A straggler wastes cluster capacity the same way a skewed stage does: every executor other
than the one running the slow task finishes early and idles, while total job time still
tracks the single slowest task. Because a straggler's duration can be inflated by a GC
pause[^1] or a slow [shuffle](#shuffle) fetch[^1] rather than genuinely more work, it's worth checking
those angles (and whether the real cause is skew rather than anything task-local) before
assuming a hardware explanation.

## How to fix it

- Enable speculative execution: `spark.speculation` is `false` by default, so nothing reruns
  a slow task automatically until it's turned on[^2].
- Tune the trigger: `spark.speculation.quantile` (default `0.9`) sets how much of the stage
  must finish before speculation kicks in, and `spark.speculation.multiplier` (default `3`)
  sets how many times slower than the median a task must be. For stages with very few tasks,
  `spark.speculation.task.duration.threshold` (available since 3.0.0) gives an absolute-duration
  trigger instead of relying on the median[^2].
- Since Spark 3.4, `spark.speculation.efficiency.enabled` (default `true`) adds a filter so a
  task is only speculated if its data-process rate is below the stage average (times
  `spark.speculation.efficiency.processRateMultiplier`, default `0.75`) or its duration exceeds
  `spark.speculation.efficiency.longRunTaskFactor` (default `2`) times the same time threshold.
  This avoids wasting a duplicate task slot on work that's simply doing more, not running
  slower[^2].
- If the cause is really a skewed key, treat it as [task skew](#bottleneck-skew) instead: AQE's
  skew-join optimization automatically splits a partition once it's larger than
  `spark.sql.adaptive.skewJoin.skewedPartitionFactor` (default `5.0`) times the median
  partition size and above `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes`
  (default `256 MB`)[^2][^3]. Manual salting (appending a random prefix to the skewed key so
  it spreads across more partitions) is the pre-AQE fallback, though the design doc behind
  AQE's skew handling calls salting and other manual approaches limited compared to the
  automatic option[^4].

> **PySpark:** speculation settings can be set on the session directly, no `spark-submit` flag
> needed: `spark.conf.set("spark.speculation", "true")`, then the quantile/multiplier
> equivalents the same way.

Speculation config: defaults shown, plus the absolute-duration trigger for small stages:

```properties
# Speculatively relaunch straggler tasks (OFF by default)
spark.speculation=true
spark.speculation.quantile=0.9          # default; portion of tasks finished before speculation begins
spark.speculation.multiplier=3          # default; multiple of median duration that marks a task slow

# Absolute-duration trigger for stages with very few tasks (since Spark 3.0)
spark.speculation.task.duration.threshold=10s   # 10s is an example
```

## Confidence

Validated.

## Limitations / false-positive risk

The 4x-median rule flags a slow task, but slow is not the same as broken. The same threshold trips on a skewed key that simply has more data to process, or on a task that spent its time in a GC pause rather than doing extra work, so a flagged task is not automatically a slow host. Small stages make this worse: with only a handful of tasks the median is unstable, and one moderately slow task can look like a straggler against a median computed from too few peers.

## Related

- **When the real cause is a skewed key:** [Partitioning](#partitioning), [Adaptive Query Execution](#aqe)

[^1]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
[^2]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^3]: [Optimizing Skew Join (Spark SQL, DataFrames and Datasets Guide)](https://spark.apache.org/docs/latest/sql-performance-tuning.html#optimizing-skew-join)
[^4]: [SPARK-29544: Optimize Skewed Join at Runtime with New Adaptive Execution](https://issues.apache.org/jira/browse/SPARK-29544)
