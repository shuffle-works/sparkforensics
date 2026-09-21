# Caching & Persistence

## How persisting and checkpointing differ

Spark's `persist()` is the general mechanism for keeping a DataFrame's already-computed partitions around instead of recomputing them from source on every action; `cache()` is shorthand for `persist(StorageLevel.MEMORY_AND_DISK)`: it calls persist with that one fixed level internally[^2], whereas persist() lets you choose any storage level (in-memory vs on-disk, serialized vs deserialized, replicated or not)[^1]. When the level passed to persist() is exactly `MEMORY_AND_DISK`, the two calls are identical[^2].

Each storage level is defined by five attributes: `useDisk`, `useMemory`, `useOffHeap`, `deserialized`, and `replication`[^3]. Under `MEMORY_AND_DISK`, Spark stores data directly as objects in memory and serializes only the portion that doesn't fit, writing that overflow to disk[^1]. `MEMORY_AND_DISK_SER` behaves the same way except the data kept in memory is also serialized (data written to disk is always serialized under either level)[^1]. Serialized byte streams use less memory than deserialized JVM objects, which carry structural overhead, but reading them back costs more CPU than reading deserialized objects directly[^3][^4].

Checkpointing is a related but distinct mechanism. Instead of persisting, it writes an RDD's partitions to an external, reliable store (HDFS, S3) and drops the lineage, the dependency chain Spark would otherwise use to recompute it[^3][^5]. That truncation doesn't happen the instant `.checkpoint()` is called; the call only marks the RDD, and the actual truncation runs later, in `doCheckpoint()`, after a job using the RDD completes. At that point the RDD is already materialized, and its dependencies and old parents are cleared[^6]. A related call, `localCheckpoint()`, also truncates lineage using Spark's caching layer, but trades fault tolerance for speed: its data lives in ephemeral local executor storage rather than a reliable filesystem, so losing an executor mid-computation can make that data permanently unrecoverable[^6].

## When caching pays off

Because of how that materialization works, caching earns its keep only in specific situations. It's worth reaching for when the same DataFrame is scanned or recomputed more than once downstream: repeated queries against the same base data, iterative ML training loops, or interactive exploration where a dataset feeds multiple branches[^1][^7]. In one book benchmark, caching a 10M-row DataFrame and materializing it with `count()` cut a subsequent `count()` from 5.11s to 0.44s, roughly a 12x speedup[^1].

A few signals point the other way, toward caching having no effect or actively hurting:

- **Single-use data.** If a dataset is processed only once downstream, caching just adds serialization and storage-bookkeeping cost for no reuse benefit[^7].
- **Data too big to fit.** Caching is all-or-nothing per partition: a DataFrame can be "fractionally cached" across its partitions, but individual partitions can't be split. With room for only 4.5 of 8 partitions, exactly 4 get cached; the uncached remainder is recomputed on every access, which can end up slower than not caching at all[^1].
- **Partial materialization.** `cache()`/`persist()` are lazy: nothing is cached until an action forces a full pass. `count()` forces a genuine full pass and materializes every partition, but an action like `take(1)` computes and caches only the one partition Catalyst needs, so a later full scan still recomputes most of the data. The same applies to `take(10)`, `limit(100)`, or any other partial or filtered scan: only the blocks Spark was forced to touch get cached, and the rest stays lazily uncomputed[^1][^2].
- **Plan mismatch.** Caching wraps the *analyzed* (pre-optimization) logical plan in an `InMemoryRelation`. A logically-equivalent query written differently produces a different analyzed plan, so Spark can silently miss the cache and recompute from scratch even though the optimized plan would have been identical[^2].
- **Optimizer limitations.** Caching freezes Catalyst's optimization opportunities at the cached point. It can, for example, block [predicate pushdown](#data-formats) once data is served from the in-memory cache instead of the source[^5].

## Why cached blocks don't stick around

Materializing a cache is only half the story, though. A `cache()` followed by `count()` guarantees a materialization pass over every partition at that moment: caching happens locally and incrementally, with each executor's BlockManager storing only the blocks it computes, as it computes them, and no centralized "cache the whole dataset" step[^2]. It does not guarantee those partitions stay cached afterward. Two things can undo it:

- **Executor loss.** If a block was cached on an executor that later goes away, the cached data goes with it, unless a replicated storage level such as `MEMORY_AND_DISK_2` was used[^2]. This matters specifically for [dynamic allocation](#cluster-config): Spark's documentation is explicit that caching together with dynamic allocation "is NOT safe," because reclaiming idle executors takes their cached blocks with them[^6].
- **Memory pressure eviction.** Cached blocks can be evicted by other operations' memory demands after materialization, independent of any executor loss[^2].

Eviction itself is governed by LRU: Spark removes the least-recently-used cached blocks when storage memory is under pressure[^3][^2][^8]. The trigger is memory contention between Spark's [unified Execution and Storage regions](#memory-model): under the `UnifiedMemoryManager`, Execution has priority, so if a task needs execution memory for a shuffle, join, aggregation, or sort and Storage is occupying that space, Spark evicts cached blocks to free it, and this can happen at any time, not only the next time the cache is accessed[^9][^2]. What happens to an evicted block depends on its storage level, not on a separate spill decision: a disk-backed level (`MEMORY_AND_DISK`, `MEMORY_AND_DISK_SER`) spills the block to disk and reads it back on next use, at the cost of disk I/O; a memory-only level (`MEMORY_ONLY`) simply drops the block and recomputes it from source when needed again[^1][^10][^3][^2].

<img class="light-only" src="diagrams/cache-lifecycle.svg" alt="A cached block moves to evicted under memory pressure or lost when an executor goes away, then either spills to disk under MEMORY_AND_DISK or recomputes from lineage under MEMORY_ONLY.">
<img class="dark-only" src="diagrams/cache-lifecycle.dark.svg" alt="A cached block moves to evicted under memory pressure or lost when an executor goes away, then either spills to disk under MEMORY_AND_DISK or recomputes from lineage under MEMORY_ONLY.">

There's no hard limit on how many DataFrames can be cached simultaneously; the constraint is aggregate storage memory, not a count of objects[^1]. That budget is fraction-based configuration translated into a live byte allowance, not a fixed absolute constant: `spark.memory.fraction` (default 0.6) sets the fraction of (heap minus a 300MB reserved region) used for the combined Execution+Storage region, and `spark.memory.storageFraction` (default 0.5) sets the portion of that region immune to eviction. Lowering either makes [spills](#bottleneck-spill) and evictions more frequent[^4][^9][^2].

## Habits that keep caching effective

A few habits keep caching effective despite how easily any of that goes wrong:

- **Materialize deliberately.** Because caching is lazy, follow `cache()`/`persist()` with an action that forces a full pass (`count()` is the standard choice) rather than assuming the call alone did the work[^1][^7].
- **Match the storage level to the constraint you're solving.** `cache()` / `MEMORY_AND_DISK` is a reasonable default: Spark keeps deserialized objects in memory and only serializes the overflow to disk. Reach for `MEMORY_AND_DISK_SER` when memory pressure is the binding constraint and you can afford the extra CPU cost of deserializing on read[^1][^4][^3].
- **Protect cached data from dynamic allocation.** If executors holding cached blocks might be reclaimed as idle, raise `spark.dynamicAllocation.cachedExecutorIdleTimeout` so they aren't pulled out from under the cache[^6], or use a replicated storage level (e.g., `MEMORY_AND_DISK_2`) so losing one executor doesn't lose the data[^2].
- **Reach for checkpointing, not persisting, for genuine lineage truncation with fault tolerance** across a long transformation chain, since it writes to a reliable external filesystem rather than relying on executor-local memory or disk[^3][^5]. Avoid `localCheckpoint()` under dynamic allocation for the same reason caching is unsafe there: its data lives in ephemeral local executor storage that can vanish along with a reclaimed executor[^6]. Also set a checkpoint directory via `SparkContext.setCheckpointDir` before calling `.checkpoint()`; without one, the call throws immediately rather than silently doing nothing[^6].
- **Don't cache data that won't benefit:** single-use datasets, datasets that don't fit in available memory, or datasets you only ever touch through partial actions (`take`, `limit`). In each of these cases the caching overhead isn't paid back[^7][^1].

## Sources

[^1]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das & Lee, ch. 7 — Optimizing and Tuning Spark Applications
[^2]: [Explaining the Mechanics of Spark Caching](https://luminousmen.com/post/explaining-the-mechanics-of-spark-caching)
[^3]: *High Performance Spark, 2nd Edition*, Karau, Polak & Warren, ch. 7 — Effective Transformations
[^4]: [Configuration — Spark](https://spark.apache.org/docs/latest/configuration.html)
[^5]: [Spark Tips: Caching](https://luminousmen.com/post/spark-tips-caching)
[^6]: [RDD.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/core/src/main/scala/org/apache/spark/rdd/RDD.scala)
[^7]: *Spark: The Definitive Guide*, Chambers & Zaharia, ch. 19 — Performance Tuning
[^8]: [Task Memory Management in Spark](https://raw.githubusercontent.com/spoddutur/spark-notes/master/task_memory_management_in_spark.md)
[^9]: [Dive into Spark Memory](https://luminousmen.com/post/dive-into-spark-memory)
[^10]: [RDD Programming Guide](https://spark.apache.org/docs/latest/rdd-programming-guide.html)
