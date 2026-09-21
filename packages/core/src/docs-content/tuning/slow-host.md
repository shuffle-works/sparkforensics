# Slow Host

<span class="tag">HOST</span>

## What it is

A slow host bottleneck shows up when one machine in the cluster consistently turns in slower
task times than its peers, independent of any single task's own data size. Unlike a stray
[straggler task](#bottleneck-straggler), the effect is host-wide: every task Spark schedules there runs behind, which
drags out the stage even when the workload itself is partitioned evenly.

## How it's detected

Spark's event log carries the per-task detail behind this: turning on `spark.eventLog.enabled`
logs the events that encode what the UI displays, persisted to storage[^1], and that same log
backs the UI's Stages tab, which drills down into individual tasks and shows per-task metrics
such as duration, GC time, and shuffle bytes read[^2].

A host reads as slow against the following synthetic threshold: host mean task
duration ≥ 2× overall median AND the host holds ≥ 20% task share; the signal only applies with
`taskCount ≥ 15` and `hosts.length ≥ 3`.

## Why it matters

A host running persistently slow tasks behaves like a bottleneck baked into the cluster rather
than into the workload: every task Spark places there inherits the delay, and since a stage's
completion time is bounded by its slowest tasks, the rest of the cluster idles while the
affected host catches up. Left alone, the same host keeps dragging down every later stage and
job that lands work on it.

## How to fix it

- Turn on speculative execution (`spark.speculation`, off by default) so Spark relaunches a
  copy of a task that's lagging far behind its peers instead of waiting on the slow host to
  finish it. A stage only becomes eligible once `spark.speculation.quantile` (default `0.9`) of
  its tasks have completed, and a task then qualifies once it runs more than
  `spark.speculation.multiplier` (default `3`) times the median duration, subject to a
  `spark.speculation.minTaskRuntime` floor (default `100ms`) so short tasks aren't speculated
  purely for looking slow, or, since Spark 3.4, an efficiency check
  (`spark.speculation.efficiency.enabled`, default `true`) that also requires the task's
  data-processing rate to lag the stage average[^3].
- If the slow host also happens to hold data locality for the affected tasks, lowering
  `spark.locality.wait` (default `3s`), or the level-specific `spark.locality.wait.node`,
  `.rack`, and `.process` overrides, shortens how long Spark waits for a data-local slot
  before falling back to a less-local executor[^3].

Turn on speculation and, if the slow host holds locality, shorten the wait; defaults shown:

```properties
# Relaunch tasks stuck on a slow host (speculation is OFF by default)
spark.speculation=true
spark.speculation.quantile=0.9          # default; fraction of tasks done before speculation starts
spark.speculation.multiplier=3          # default; a task must run > 3x the median to be relaunched

# If the slow host holds data locality, wait less before falling back to another executor
spark.locality.wait=3s                  # default; lower to fall back sooner
```

## Confidence

The core `durationShare` dimension is validated: it measures host-wide task-duration
inflation against the cluster median, the signal that separates a genuinely slow machine from
normal task-time variance. Two secondary dimensions run best-effort and stay experimental. The
`multiDim` dimension <span class="tag">EXPERIMENTAL</span> folds several per-host signals into
one score, but that combined heuristic has not been validated. The `storageMemory` dimension
<span class="tag">EXPERIMENTAL</span> likewise reads host-level memory pressure as a
contributing factor without validation, so treat both as hints rather than verdicts.

## Limitations / false-positive risk

A host that looks slow is not always a bad node. It can simply hold data locality for the
tasks scheduled there, or carry one heavy stage that happens to be pinned to it, either of
which inflates its mean task time without any hardware fault. The multi-dimensional scoring
that reinforces the core signal is best-effort, so a match warrants a look at what that host was
actually running before you conclude the machine itself is the problem.


## Stage slowness {#bottleneck-stage-slowness}

<span class="tag">SLOW</span> <span class="tag">EXPERIMENTAL</span>

This is an experimental fallback heuristic that shares the slow-host anchor and is suppressed
whenever `slowHost` fires. It answers a different question: when no single machine is dragging,
why does one stage still lag the rest of the job? The cause usually traces back to how the work
was divided rather than where it ran.

**Too few partitions caps parallelism.** Wide stages (joins, groupBy, aggregations) take their
partition count from `spark.sql.shuffle.partitions`, which sits at a default of 200 whether the
shuffle moves 20 MB or 500 GB unless you change it[^4]. When that count is small relative to the
cluster, only a handful of tasks carry the stage while cores sit idle, so it stretches out even
as better-sized neighbors finish quickly. The first move is to raise its parallelism, aiming for
at least two or three tasks per CPU core on a data-heavy stage, tuned through
`spark.default.parallelism` and `spark.sql.shuffle.partitions`[^5].

**Large data volume per task makes each task run long.** That 200-partition default does not
scale with input size, so a stage handling hundreds of gigabytes hands each task a large slice:
fewer tasks run at once, per-executor load climbs, and the stage often trips memory errors.
Roughly 100-200 MB per task tends to work well, and tasks grinding through around 3 GB each
while spilling are a sign you need more partitions[^4].

**Heavy shuffle and spill inflate the stage's cost.** Shuffles move data across executors so
rows with the same key land together, and during those map and [shuffle](#shuffle) operations Spark writes
to and reads from local-disk shuffle files, which is heavy I/O that can become a bottleneck
under the default configuration[^2]. Volume per task feeds straight into it: once a partition
outgrows the memory available in an executor, Spark [spills](#bottleneck-spill) part of the data to disk, and spills
are about the slowest thing a job can do because of the extra disk I/O and garbage collection,
so the stage finishes but runs far less efficiently than the rest[^4].

## Related

- **Speculation & locality tuning:** [Cluster Tuning](#cluster-config)

[^1]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
[^2]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das, Lee, ch. 7
[^3]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^4]: [Spark Partitions](https://luminousmen.com/post/spark-partitions)
[^5]: *Spark: The Definitive Guide*, Chambers & Zaharia (O'Reilly, 2018)
