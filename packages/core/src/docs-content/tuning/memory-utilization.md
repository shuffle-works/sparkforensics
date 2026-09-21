# Memory Utilization

<span class="tag">MEM</span>

## What it is

An executor is a single JVM process that gets a fixed memory allocation when the application starts, and it holds that whole allocation for its entire lifetime, whether or not it has work to run[^3]. Two things can leave that memory band poorly used: cores sitting idle inside a held executor, and a held executor whose memory drains of active work but is never released. This finding covers both.

An executor's core count is its concurrency ceiling. `spark.executor.cores` sets how many tasks it can run at once, so `--executor-cores 5` caps that executor at five concurrent tasks[^1]. The scheduler turns cores into task slots from `spark.executor.cores` and `spark.task.cpus` (minimum 1), with `spark.task.cpus` defaulting to one core per task[^2]. Cores go idle whenever there are fewer runnable tasks than slots: a stage with fewer partitions than the total slots across executors leaves slots empty, and so does the tail of a stage where a [straggler](#bottleneck-straggler) or two keep running after their peers finish. Raising `spark.task.cpus` above 1 has the same effect from the other side, since each task then reserves several cores and fewer run side by side. Through all of it the JVM keeps its fixed heap[^3].

## How it's detected

| Rule | Signal | Status |
|---|---|---|
| idleCores | Task parallelism below allocated cores while the executor is held | Validated |
| memoryBand | A whole executor's memory band held with little or no active work (dynamic-allocation idle timeouts) | Validated |
| wasteModel | Peak used memory well below allocated memory (unused headroom) | Experimental |

## Why it matters

A held executor is allocation you pay for regardless of how busy it is. On YARN that is the memory YARN grants the container; on Kubernetes it is the pod memory limit[^3]. When cores idle or a whole executor lingers with nothing to do, that fixed band is reserved without returning work, so the cost lands whether or not tasks are running.

## How to fix it

Keep executors from being oversized in the first place. The guidance is against packing every core of a node into one fat executor: assigning all 16 cores of a node to a single executor hurts HDFS throughput and drives excessive [garbage collection](#bottleneck-gc), so aim for a balance between tiny (one core per executor) and fat (one executor per node) sizing[^4]. On YARN, leave cores for the OS and Hadoop daemons instead of handing 100% of a node to Spark containers[^1].

For the held memory band, lean on [dynamic allocation](#cluster-config) to reclaim executors once the work drains. It requests executors when tasks back up and frees them when they go idle[^1]. Executors are added in rounds once tasks have been pending for `spark.dynamicAllocation.schedulerBacklogTimeout` (default 1s), then again every `spark.dynamicAllocation.sustainedSchedulerBacklogTimeout` while the backlog holds[^5]. On the release side, an executor is removed after it has been idle longer than `spark.dynamicAllocation.executorIdleTimeout`[^5].

Cached data is the trap here. By default an executor holding [cached blocks](#caching) is never removed, governed by `spark.dynamicAllocation.cachedExecutorIdleTimeout`, whose default is infinity[^2]. Such an executor keeps its full memory band indefinitely with no active tasks unless you set that timeout to a finite value, or turn on `spark.shuffle.service.fetch.rdd.enabled` so executors holding only disk-persisted blocks are treated as idle after `spark.dynamicAllocation.executorIdleTimeout` and released[^5]. To avoid holding barely-used executors at all, lower `spark.dynamicAllocation.executorAllocationRatio` (default 1.0, full parallelism) toward 0.5, since with small tasks full-parallelism allocation can request executors that never do any work[^2].

```properties
# Balanced executor sizing, not one fat executor per node
spark.executor.cores=5

# Reclaim idle executors; give cached holders a finite timeout
spark.dynamicAllocation.enabled=true
spark.dynamicAllocation.cachedExecutorIdleTimeout=300s
spark.dynamicAllocation.executorAllocationRatio=0.5
```

### Reading the wasted-memory estimate <span class="tag">EXPERIMENTAL</span>

The wasteModel rule estimates unused ("wasted") allocated memory from the gap between an executor's peak used memory and its allocated total. Treat it as a rough buffer heuristic, not a measurement. Peak used memory is a high-water mark rather than a ceiling: Spark records it under `peakMemoryMetrics.*`, and each figure is the maximum its pool ever reached, so peak sits at or below the allocated total by construction and the space between them is the executor's unused headroom[^6]. Turning that headroom into a wasted number stays approximate for concrete reasons. The peak heap figure counts garbage, since `JVMHeapMemory` is the peak used heap including "the amount of memory occupied by both live objects and garbage objects that have not been collected," so it overstates the live footprint[^6]. The region boundaries also move: `totalOnHeapStorageMemory` and `totalOffHeapStorageMemory` "can vary over time, depending on the MemoryManager implementation," so there is no single fixed allocated-to-storage value to subtract a peak from[^6]. Peak metrics only reach the event log when `spark.eventLog.logStageExecutorMetrics` is true[^6], so without that setting there is nothing to estimate from. Use the number as a hint that an executor may be oversized, then confirm against sizing before acting on it.

## Confidence

The idleCores and memoryBand rules are validated: they rest on documented Spark concurrency and dynamic-allocation behavior. The wasteModel estimate is low-confidence and experimental. It is a buffer heuristic derived from peak-versus-allocated sampling, not an exact accounting of unused memory, so it should steer investigation rather than settle it.

## Limitations / false-positive risk

Idle cores are not always waste. The tail of a stage legitimately leaves slots empty while a straggler or two finish[^2], so a snapshot of low parallelism can reflect a normal straggler tail rather than chronic under-utilization. The wasted-memory estimate depends on peak-memory sampling and is only as good as that sampling: the peak includes uncollected garbage, the managed-region boundaries shift under the MemoryManager, and the figures are absent entirely unless `spark.eventLog.logStageExecutorMetrics` is enabled[^6].

[^1]: [How to Tune Your Apache Spark Jobs (Part 2)](https://blog.cloudera.com/how-to-tune-your-apache-spark-jobs-part-2/)
[^2]: [Configuration — Spark](https://spark.apache.org/docs/latest/configuration.html)
[^3]: [Dive into Spark memory](https://luminousmen.com/post/dive-into-spark-memory)
[^4]: [Distribution of executors, cores and memory for a Spark application](https://raw.githubusercontent.com/spoddutur/spark-notes/master/distribution_of_executors_cores_and_memory_for_spark_application.md)
[^5]: [Job Scheduling — Spark](https://spark.apache.org/docs/latest/job-scheduling.html)
[^6]: [Monitoring — Spark](https://spark.apache.org/docs/latest/monitoring.html)
