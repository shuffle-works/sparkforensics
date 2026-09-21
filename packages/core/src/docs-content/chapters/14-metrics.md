# Metrics Glossary

<!-- #metric-* IDs are docs-internal, forward-compatible; the sibling contract consumes only #bottleneck-*. Rename-safe until the sibling deep-links metrics. -->

Reference for every metric surfaced elsewhere in this guide: what it measures, where Spark records it in the event log, and what a problematic value looks like.

## Task duration (P50/P95/max) {#metric-task-duration}

Per-task wall-clock duration, aggregated across a stage's tasks into percentiles (P50, P95, max) to surface skew and stragglers. It is computed from `SparkListenerTaskEnd` events rather than read off a single field: each task end carries its own duration, and the percentiles are derived by aggregating those values across the stage.

A problematic value looks like a small fraction of tasks running far past the rest: a stage is classified as a straggler when more than 5% of tasks run at least 4x the median duration (with at least 10 tasks in the stage), or when speculative tasks were fired.

## Shuffle read bytes {#metric-shuffle-read-bytes}

The volume of shuffle data a task reads from remote executors, recorded in `taskMetrics.shuffleReadMetrics.remoteBytesRead`.

## Shuffle write bytes {#metric-shuffle-write-bytes}

The size of the shuffle output a task writes, recorded in `taskMetrics.shuffleWriteMetrics.bytesWritten`. Spark's own metric description calls it simply the "Number of bytes written in shuffle operations," without stating compression state on its own[^1].

The sort-based shuffle writer fills in the mechanics: incoming records are serialized as soon as they reach the shuffle writer and buffered in serialized form while sorting[^2]. When the spill compression codec supports concatenating compressed data, the final merge step concatenates the already-compressed spill partitions directly into the output file, using `transferTo` rather than decompressing and recompressing[^2]. So `bytesWritten` counts compressed, post-serialization bytes, and in this common fast-merge path the final written output is built directly from data that had already been spilled to disk during sorting, rather than written fresh at merge time.

## Memory bytes spilled {#metric-memory-bytes-spilled}

Bytes a task spilled from in-memory structures, recorded in `taskMetrics.memoryBytesSpilled`. Any value above zero is a spill warning, with the skew-vs-volume classification (based on what fraction of a stage's tasks show zero spill) as the actionable signal.

## Disk bytes spilled {#metric-disk-bytes-spilled}

The on-disk counterpart to memory spill: bytes a task spilled to disk, recorded in `taskMetrics.diskBytesSpilled`. It feeds the same spill classification as memory bytes spilled.

## JVM GC time {#metric-jvm-gc-time}

Elapsed time the JVM spent in garbage collection while a task executed, recorded in `taskMetrics.jvmGCTime` and expressed in milliseconds[^1]. The value is cumulative across the task's full execution window: the sum of every GC pause that occurred during that task's run, not just the most recent one[^1]. This matches how it's serialized: as a single scalar long, consistent with an accumulator rather than a per-GC-event log entry[^3].

## gcPct {#metric-gcpct}

A synthetic ratio, `jvmGCTime / executorRunTime`, not a raw Spark field. It drives GC-bottleneck classification: above 10% is a warning, above 20% is critical.

## Executor run time {#metric-executor-run-time}

Elapsed time the executor spent running a task, recorded in `taskMetrics.executorRunTime` and expressed in milliseconds[^1]. `TaskMetrics` (and therefore `executorRunTime`) is serialized as an optional part of the `SparkListenerTaskEnd` payload, not guaranteed on every task end[^3]. In practice it is available for failed tasks that got far enough to actually run, such as `ExceptionFailure` or `TaskKilled`. The event-log deserialization code even falls back to reading accumulator updates out of the embedded `TaskMetrics` for old, Spark-1.x-era logs, which only makes sense if the metrics object is normally populated for that failure type[^3]. It can be absent for reasons like `Resubmitted`, where the task attempt never completed on that executor[^3].

## Fetch wait time ratio {#metric-fetch-wait-time-ratio}

A synthetic ratio, `fetchWaitTime / taskDuration`, not a raw Spark field: the time a task spent blocked waiting on remote shuffle blocks, relative to its total duration.

## Input bytes {#metric-input-bytes}

Bytes a task read as input, recorded in `taskMetrics.inputMetrics.bytesRead`.

## Output bytes {#metric-output-bytes}

Bytes a task wrote as output, recorded in `taskMetrics.outputMetrics.bytesWritten`.

## I/O ratio {#metric-io-ratio}

A synthetic ratio, `outputBytes / inputBytes`, not a raw Spark field.

## Peak execution memory {#metric-peak-execution-memory}

Peak memory recorded in `taskMetrics.peakExecutionMemory`. This is a task-level accumulator, distinct from the separate executor-level `peakMemoryMetrics.OnHeapExecutionMemory` and `.OffHeapExecutionMemory` gauges, which report the on-heap and off-heap execution pools as two separate numbers at the executor level rather than as a single per-task figure[^1].

## Failed tasks / failure rate {#metric-failed-tasks}

Tasks whose `SparkListenerTaskEnd` reason is not `Success`. The `Reason` field holds the formatted class name of whichever `TaskEndReason` was assigned to that task end[^3], and the canonical set of reasons includes `FetchFailed`, `ExceptionFailure`, `TaskResultLost`, `TaskKilled`, `TaskCommitDenied`, `ExecutorLostFailure`, and `UnknownReason`[^3]. Because `TaskMetrics` is only an optional part of the task-end payload, it can be absent for some of these reasons: for example `Resubmitted`, where the task attempt never actually completed on that executor[^3].

## Speculative tasks / straggler count {#metric-speculative-tasks}

Tasks launched as speculative retries of a slow-running task, recorded via `SparkListenerTaskStart` where `speculative = true`. Any speculative task firing (or more than 5% of a stage's tasks running at least 4x the median duration, with at least 10 tasks in the stage) is a straggler signal.

## Executor count (added/removed/concurrent) {#metric-executor-count}

The number of executors added, removed, or concurrently running, recorded via `SparkListenerExecutorAdded` / `SparkListenerExecutorRemoved` events.

## Stage wall-clock duration {#metric-stage-duration}

A stage's total elapsed time, recorded from `SparkListenerStageCompleted`: `completionTime − submissionTime`.

## firstStageSubmittedAt {#metric-first-stage-submitted-at}

A synthetic field: the timestamp of the first `SparkListenerStageSubmitted` event in the event log. The gap between this timestamp and the application's start time drives cold-start classification: more than 30 seconds is a warning.

## Sources

[^1]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
[^2]: [SortShuffleManager.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/core/src/main/scala/org/apache/spark/shuffle/sort/SortShuffleManager.scala)
[^3]: [JsonProtocol.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/core/src/main/scala/org/apache/spark/util/JsonProtocol.scala)
