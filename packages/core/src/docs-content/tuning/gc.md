# GC Pressure

<span class="tag">GC</span>

## What it is

GC pressure describes how much of an executor's time goes to JVM garbage collection instead
of running task code. Spark tracks this directly in its per-task metrics: `jvmGCTime` sits
alongside `executorRunTime`, the elapsed wall-clock time the executor spent running the task
(as opposed to `executorCpuTime`, which measures CPU time specifically).[^1] `jvmGCTime` is not
additive on top of that duration: it's defined as the elapsed time the JVM spent in garbage
collection *while executing the task*, so GC pauses fall inside the same wall-clock window
`executorRunTime` already measures, not outside it. Summing the two would double-count the GC
pauses and overstate how long the task actually ran.[^1]

## How it's detected

Because `jvmGCTime` sits inside `executorRunTime` rather than alongside it, the ratio between
the two gives a bounded read on how much of a task's wall-clock time went to garbage collection:

| gcPct = jvmGCTime / executorRunTime | Level |
|---|---|
| > 10% | Warning |
| > 20% | Critical |

## Why it matters

As gcPct climbs past these thresholds, a growing share of every task's wall-clock time is
consumed by garbage collection instead of actual computation, so the executor's useful
throughput drops even while it appears busy. Two causes show up repeatedly: oversized
executors, and an on-heap memory split pushed too far toward execution/storage.

Sizing an executor with too many cores relative to its heap is one documented trigger: a
fat-executor configuration using all 16 cores of a node was observed to not only hurt HDFS
throughput but also "result in excessive garbage [collection]."[^2]

Pushing `spark.memory.fraction` too far toward its upper end has a similar effect through a
different path. Its complement, `1 − spark.memory.fraction`, is untracked "User Memory"
reserved for UDFs, Python/Arrow glue, and native library buffers; Spark doesn't manage this
region at all, and starving it (which is what raising `spark.memory.fraction` toward
something like 0.9 does) leads to "GC pressure or random OOMs," with no warning before the
failure.[^3]

## How to fix it

- Keep cores per executor down rather than packing an entire node's cores onto one JVM (the
  common ~5-cores-per-executor guideline). That avoids the excessive-garbage-collection
  failure mode documented for fat-executor configurations.[^2]
- Don't raise `spark.memory.fraction` past a comfortable range chasing more execution/storage
  memory: doing so starves the untracked user-memory region and risks the same
  GC-pressure/OOM failure mode.[^3]
- Move Tungsten's execution and storage buffers off the JVM heap with
  `spark.memory.offHeap.enabled=true` (and a positive `spark.memory.offHeap.size`, which is
  required whenever off-heap is enabled[^4]). Off-heap buffers are invisible to the garbage
  collector, so fewer and smaller live objects need to be tracked, scanned, and copied on the
  heap, reducing both the frequency and duration of GC pauses.[^3]
- Tune or switch the GC collector on large heaps. G1GC is Spark's default collector since 4.0
  (which defaults to JDK 17), and large executor heaps may need `-XX:G1HeapRegionSize` raised
  as well.[^5] G1's stop-the-world evacuation and full-GC pauses can still spike under heavy
  old-generation pressure on large heaps: one documented 88GB-heap benchmark saw a job's pause
  spike to nearly 100 seconds under default G1 settings, and only tuning
  `InitiatingHeapOccupancyPercent`, `ConcGCThreads`, and RSet-update parameters brought G1 back
  ahead of Parallel/CMS on both throughput and latency.[^6] ZGC is a documented alternative
  built for pause-time control: it performs its expensive work concurrently, without stopping
  application threads for more than a millisecond, with pause times designed to stay
  independent of heap size from a few hundred megabytes up to 16TB.[^7]

Move buffers off-heap and give G1 room on large heaps (sizes are examples; set to your workload):

```properties
# Move Tungsten execution/storage buffers off the JVM heap so the GC has fewer objects to scan
spark.memory.offHeap.enabled=true
spark.memory.offHeap.size=2g            # must be > 0 whenever off-heap is enabled; 2g is an example

# G1 is the default collector since Spark 4.0 (JDK 17); raise the region size on large heaps
spark.executor.extraJavaOptions=-XX:+UseG1GC -XX:G1HeapRegionSize=16m   # 16m is an example
```

## Confidence

The warning and critical thresholds on gcPct are validated: they read a bounded ratio of
`jvmGCTime` to `executorRunTime`, both first-class per-task metrics Spark records directly,[^1]
and crossing 10% or 20% marks a real, measurable share of wall-clock time lost to garbage
collection.

<span class="tag">EXPERIMENTAL</span> A separate signal treats suspiciously *low* GC time as a
possible cost-model or noise-floor indicator, and that one is an unsourced heuristic with no
external basis, so treat it as exploratory rather than a confirmed diagnostic.

## Limitations / false-positive risk

A high gcPct can reflect a transient memory spike (a single skewed task, a brief burst of
large allocations) rather than chronic pressure, so a threshold crossing on one stage does not
by itself prove a sustained sizing problem; corroborate against the executor's behavior over
the whole run. The low-GC signal has no external basis at all, and a near-zero reading is at
least as likely to mean the workload simply is not allocation-heavy as to mean anything is
wrong.

## Related

- **Why it happens:** [Memory Management](#memory-model)
- **Executor sizing:** [Cluster Tuning](#cluster-config)

[^1]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
[^2]: [Distribution of Executors, Cores, and Memory for a Spark Application](https://raw.githubusercontent.com/spoddutur/spark-notes/master/distribution_of_executors_cores_and_memory_for_spark_application.md)
[^3]: [Diving into Spark Memory Management](https://luminousmen.com/post/dive-into-spark-memory)
[^4]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^5]: [Spark Tuning Guide](https://spark.apache.org/docs/latest/tuning.html)
[^6]: [Tuning Java Garbage Collection for Apache Spark Applications](https://www.databricks.com/blog/2015/05/28/tuning-java-garbage-collection-for-spark-applications.html)
[^7]: [The Z Garbage Collector (ZGC)](https://wiki.openjdk.org/display/zgc)
