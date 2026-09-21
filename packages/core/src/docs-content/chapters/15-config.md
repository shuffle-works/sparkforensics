# Spark Config Quick-Reference

A cross-reference of the Spark and PySpark configuration properties discussed elsewhere in this guide, plus the JVM garbage-collection flags relevant to executor tuning. Defaults and version notes below are traced to Spark's own configuration docs, its SQLConf source, and the cited literature. Where a source doesn't give a hard number (a range, a ceiling, a recommended workload profile), the table leaves it out rather than guess.

## Spark properties

| Key | Default | Recommended | Notes |
|---|---|---|---|
| `spark.sql.shuffle.partitions` | 200 (unchanged since Spark 1.1.0)[^1][^2][^3] |  | AQE doesn't override this config value; see notes below for the effective runtime count. |
| `spark.sql.adaptive.enabled` | `true`[^4] | `true` | |
| `spark.sql.adaptive.coalescePartitions.enabled` | `true` (since 3.0.0)[^1] | `true` | Requires AQE; merges contiguous small post-shuffle partitions instead of one task per configured partition[^1]. |
| `spark.sql.adaptive.coalescePartitions.initialPartitionNum` | unset → falls back to `spark.sql.shuffle.partitions` (200)[^1] |  | Sets the partition count entering the coalescing step. |
| `spark.sql.adaptive.coalescePartitions.parallelismFirst` | `true` (since 3.2.0)[^1][^5] | `false` on busy clusters[^1] | When `true`, ignores `advisoryPartitionSizeInBytes` and derives a target from the cluster's default parallelism, respecting only the `minPartitionSize` floor. |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64MB (since 3.0.0)[^1][^4][^5] |  | Ignored during coalescing when `parallelismFirst=true` (the default). |
| `spark.sql.adaptive.coalescePartitions.minPartitionSize` | 1MB (since 3.2.0)[^5] |  | Floor enforced when the target size is ignored: the default `parallelismFirst=true` case[^1]. |
| `spark.memory.fraction` | 0.6[^6] |  | See notes below; no hard 0–1 ceiling documented in the cited sources. |
| `spark.memory.storageFraction` | 0.5[^7] |  | A fraction *of* the region sized by `spark.memory.fraction`, not an independent pool; see notes below. |
| `spark.sql.execution.arrow.pyspark.enabled` | `false`[^8] |  | See PySpark callout below. |
| `spark.sql.execution.arrow.pyspark.fallback.enabled` | `true` (inherited from the deprecated `arrow.fallback.enabled`)[^8][^5][^4] |  | Falls back to the non-Arrow path automatically if a conversion error occurs, before computation runs[^8]. |
| `spark.dynamicAllocation.shuffleTracking.enabled` | `true` (since 3.0.0)[^4] |  | Lets dynamic allocation track shuffle files per executor without an external shuffle service. |
| `spark.dynamicAllocation.shuffleTracking.timeout` | `infinity`[^4] |  | Executors holding shuffle data wait for it to be garbage collected before release, by default; set a finite value if GC isn't keeping up. |
| `spark.shuffle.service.enabled` |  |  | External shuffle service; see `#config-shuffle-service` below. |
| `spark.dynamicAllocation.minExecutors` / `maxExecutors` | `0` / `infinity`[^4] |  | Autoscale bounds; see `#config-autoscale-bounds` below. |
| `spark.serializer` | `org.apache.spark.serializer.JavaSerializer`[^4] | `KryoSerializer` | See `#config-serializer` below. |
| `spark.executor.memoryOverhead` | greater of 10% of executor memory or 384MB[^7] |  | Off-heap overhead; see `#config-memory-overhead` below. |

### Shuffle partitions and AQE coalescing

The 200 default for `spark.sql.shuffle.partitions` hasn't moved since 1.1.0, and AQE (on by default since Spark 3.0) doesn't change that config value[^1][^2][^3]. What it changes is the effective number of partitions used at runtime. With `coalescePartitions.enabled` also on by default, Spark merges small contiguous post-shuffle partitions instead of running one task per configured partition[^1]. Because `parallelismFirst` defaults to `true` since 3.2.0, that merge target usually isn't the 64MB `advisoryPartitionSizeInBytes` value; it's derived from the cluster's default parallelism, with `minPartitionSize` (1MB) as the only enforced floor[^1][^5]. Databricks' own writeup on AQE shows the reduce-task count actually shrinking based on measured data volume[^9], and Learning Spark accordingly calls the static 200 default "too high for smaller or streaming workloads"[^3]. A related, distinct knob (`spark.sql.adaptive.coalescePartitions.minPartitionNum`) sets a minimum parallelism floor for data that's slow to compute despite being small, per High Performance Spark[^10].

### `spark.memory.fraction` and `spark.memory.storageFraction`

`spark.memory.fraction` sizes the unified execution/storage region (M) as a fraction of (JVM heap − 300MiB); the tuning guide frames it as a knob to fit M "comfortably within the JVM's old or tenured generation" rather than stating an enforced numeric range[^6]. The cited sources document no failure threshold tied to a specific value like 0.9. What they do document is the risk of pushing the fraction high: the complement, `1 − spark.memory.fraction`, is untracked "User Memory" for UDFs, Python/Arrow glue, and native buffers, and starving it (which is what raising the fraction toward 0.9 does) leads to "GC pressure or random OOMs," with no warning from Spark[^7].

`spark.memory.storageFraction` isn't independent of that: it's a fraction *of* M, the same region `spark.memory.fraction` sizes[^6]. Inside that shared pool, execution can evict storage down to the threshold set by `storageFraction`, but storage can never evict execution[^11][^6]. With the defaults (0.6 and 0.5), that works out to execution and storage each getting 30% of usable heap; raising `memory.fraction` scales both pools at once, while `storageFraction` only re-splits the pool that's already been carved out[^7].

> **PySpark:** `spark.sql.execution.arrow.pyspark.enabled` is off by default and governs Arrow use for `DataFrame.toPandas()` and `SparkSession.createDataFrame()` from a Pandas DataFrame or NumPy array[^8]. Its documented risk is a type-coverage gap, not silent data corruption: `ArrayType` of `TimestampType` is explicitly unsupported[^4][^5], and more generally an unsupported column type raises an error rather than converting wrongly[^8]. `spark.sql.execution.arrow.pyspark.fallback.enabled` defaults to `true` and automatically falls back to the non-Arrow path if a conversion error occurs, before any computation runs[^8][^5][^4]. So the failure mode is an exception plus fallback, not a wrong result. Separately, and not specific to this Arrow config, PySpark's own type coercion has its own hazards: numeric values passed for `ByteType`/`ShortType`/`IntegerType` must fall within fixed ranges or get rejected or converted unexpectedly[^2].

### Shuffle service {#config-shuffle-service}

During a shuffle, an executor writes its map output to local disk and then serves fetch requests for that data itself[^14]. Dynamic allocation can reclaim an idle executor before a later stage has fetched all the shuffle blocks it holds (especially with stragglers, tasks that run much longer than their peers), and once that executor is gone, any stage that still needs its shuffle output gets a `FetchFailed` and has to recompute it[^14]. The external shuffle service fixes this by moving shuffle-block serving out of the executor process: it's a long-running process on each node, independent of any particular application's executors, and once `spark.shuffle.service.enabled` is `true`, executors fetch shuffle blocks from it instead of from each other, so an executor's shuffle output keeps being served after that executor is reclaimed[^14][^4]. Setting up dynamic allocation requires enabling this service on every worker node in addition to `spark.dynamicAllocation.enabled`[^2]. As of Spark 3.0, shuffle-file tracking (`spark.dynamicAllocation.shuffleTracking.enabled`) is an alternative to the external shuffle service for the same safe-removal problem[^4].

**Limitations / false-positive risk:** the service can be intentionally left off when dynamic allocation relies on shuffle-file tracking instead, so a disabled setting is not automatically a misconfiguration.

### Autoscale bounds {#config-autoscale-bounds}

By default, `spark.dynamicAllocation.minExecutors` is `0` and `spark.dynamicAllocation.maxExecutors` is `infinity`[^4]. Leaving `maxExecutors` unset therefore leaves dynamic allocation unbounded on the high end as far as Spark itself is concerned; in practice the ceiling ends up being whatever the cluster or scheduler enforces outside Spark[^4]. `spark.dynamicAllocation.initialExecutors` defaults to `minExecutors`, unless `--num-executors` (or `spark.executor.instances`) sets a larger starting value[^4]. Whatever executor count `executorAllocationRatio` computes to maximize parallelism, that target is still clamped by the `minExecutors`/`maxExecutors` floor and ceiling[^4].

**Limitations / false-positive risk:** an unbounded `maxExecutors` is often deliberate on clusters where the scheduler enforces the real ceiling, so an unset high end is not always wrong.

### Serializer {#config-serializer}

The default `spark.serializer` is `org.apache.spark.serializer.JavaSerializer`, which works with any `Serializable` Java object but is "quite slow"; Spark's configuration reference recommends switching to `KryoSerializer` "when speed is necessary"[^4]. The tuning guide is more specific: Kryo is "significantly faster and more compact than Java serialization (often as much as 10x)," though it doesn't support all `Serializable` types and needs its classes registered in advance for best performance[^6]. That registration requirement is the stated reason Kryo isn't the default: "The only reason Kryo is not the default is because of the custom registration requirement," and Spark recommends trying it for any network-intensive application[^6]. Since Spark 2.0.0, Spark internally uses Kryo regardless of this setting when shuffling RDDs of simple types, arrays of simple types, or strings, and auto-registers common Scala classes via Twitter chill's `AllScalaRegistrar`[^6]. A practitioner summary puts Java serialization at "2-10x slower and larger on the wire" on every shuffle, with the caveat that classes left unregistered silently fall back to Java serialization unless registered via `spark.kryo.classesToRegister` or `spark.kryo.registrator`[^15]. Persisting RDDs in serialized form is another case where Kryo can be more space-efficient than Java serialization[^10].

**Limitations / false-positive risk:** `JavaSerializer` may be kept on purpose when an application depends on `Serializable` types Kryo cannot handle, so a non-Kryo setting is not necessarily a mistake.

### Memory overhead {#config-memory-overhead}

`spark.executor.memoryOverhead` covers everything an executor needs outside the JVM heap sized by `spark.executor.memory`: thread stacks, JIT buffers, metaspace, JNI, native libraries, and, if `spark.executor.pyspark.memory` isn't set separately, the memory used by PySpark's per-task Python worker processes[^7]. Left unset, Spark defaults it to the greater of 10% of executor memory or 384MB[^7]; the configuration reference formalizes that floor as `spark.executor.minMemoryOverhead` (default `384m`, since Spark 4.0) and the percentage as `spark.executor.memoryOverheadFactor` (default 0.10, or 0.40 for non-JVM jobs on Kubernetes, since those need more non-JVM heap space)[^4]. The resource manager (YARN's NodeManager, or the Kubernetes kubelet) sizes the container/pod to the sum of `spark.executor.memoryOverhead`, `spark.executor.memory`, `spark.memory.offHeap.size`, and `spark.executor.pyspark.memory`[^4]. If off-heap memory or PySpark worker processes consume memory that isn't reflected in a correspondingly larger `memoryOverhead`, that extra usage still shows up in the process's actual RSS, which the resource manager does track. Once real usage exceeds the container's allocated size, the executor is killed by YARN or OOMKilled by the kubelet, with no Spark-level error, just an abrupt process death[^7].

**Limitations / false-positive risk:** the default overhead is adequate for many JVM-only jobs, so a value left at the default only signals trouble on off-heap-heavy or PySpark workloads that need more non-heap room.

## JVM GC flags

| Flag | Effect |
|---|---|
| `-XX:+UseG1GC` | Default collector since Spark 4.0.0, which defaults to JDK 17[^6]. |
| `-XX:G1HeapRegionSize` | May need raising alongside large executor heaps[^6]. |
| `-XX:InitiatingHeapOccupancyPercent` | Tuned (with `-XX:ConcGCThreads` and RSet-update settings) to fix a documented ~100-second G1 full-GC pause on an 88GB executor heap[^12]. |
| `-XX:ConcGCThreads` | See `-XX:InitiatingHeapOccupancyPercent` above[^12]. |
| `-XX:+UseZGC` | Concurrent, low-latency collector; sub-millisecond pause target independent of heap size, from a few hundred megabytes up to 16TB[^13]. |

### G1 vs. ZGC

G1 was designed as a CMS replacement aiming at both throughput and low latency: it partitions the heap into equal-sized regions and copies out only the live objects from collected regions rather than compacting the whole heap[^12]. Even so, a documented 88GB-heap Spark benchmark hit "unacceptable full GC," with one job pausing nearly 100 seconds under default G1 settings. Only after tuning `InitiatingHeapOccupancyPercent`, `ConcGCThreads`, and RSet-update parameters did G1 beat Parallel/CMS GC on both throughput and latency[^12]. ZGC, per the OpenJDK project page, "performs all expensive work concurrently, without stopping the execution of application threads for more than a millisecond," with pause times that stay flat as heap size scales from a few hundred megabytes up to 16TB[^13].

## Sources

[^1]: [Performance Tuning — Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^2]: *Spark: The Definitive Guide*, Chambers & Zaharia, ch. 4, ch. 10
[^3]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das & Lee, ch. 7
[^4]: [Configuration — Spark](https://spark.apache.org/docs/latest/configuration.html)
[^5]: [SQLConf.scala (Spark 3.5.0)](https://raw.githubusercontent.com/apache/spark/v3.5.0/sql/catalyst/src/main/scala/org/apache/spark/sql/internal/SQLConf.scala)
[^6]: [Tuning Spark](https://spark.apache.org/docs/latest/tuning.html)
[^7]: [Dive Into Spark Memory Management](https://luminousmen.com/post/dive-into-spark-memory)
[^8]: [Apache Arrow in PySpark](https://spark.apache.org/docs/3.5.8/api/python/user_guide/sql/arrow_pandas.html)
[^9]: [Adaptive Query Execution: Speeding Up Spark SQL at Runtime](https://www.databricks.com/blog/2020/05/29/adaptive-query-execution-speeding-up-spark-sql-at-runtime.html)
[^10]: *High Performance Spark, 2nd Edition*, Karau, Polak & Warren, ch. 5
[^11]: [task_memory_management_in_spark.md](https://raw.githubusercontent.com/spoddutur/spark-notes/master/task_memory_management_in_spark.md)
[^12]: [Tuning Java Garbage Collection for Spark Applications](https://www.databricks.com/blog/2015/05/28/tuning-java-garbage-collection-for-spark-applications.html)
[^13]: [ZGC — The Z Garbage Collector](https://wiki.openjdk.org/display/zgc)
[^14]: [Job Scheduling — Spark](https://spark.apache.org/docs/latest/job-scheduling.html)
[^15]: [The Apache Spark Optimization Checklist](https://luminousmen.com/post/the-apache-spark-optimization-checklist)
