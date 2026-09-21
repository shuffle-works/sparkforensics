# Join Optimization

## Join strategy selection

Spark SQL's Catalyst optimizer picks from five physical join operators: broadcast hash join, broadcast nested loop join, shuffle hash join, shuffle sort-merge join (SMJ), and shuffle-and-replicate nested loop (cartesian) join[^1]. Broadcast hash join avoids a shuffle entirely by sending one small side to every executor; it requires an equi-join condition and supports every join type except full outer[^1]. Broadcast nested loop join relaxes the equi-join requirement (it supports non-equi conditions and every join type) at the cost of scanning one side repeatedly, so it's normally a fallback rather than a first choice[^1]. Unlike hand-tuned RDD joins, where the partitioner is chosen explicitly, Spark SQL's optimizer can also push down or reorder other operators automatically to make the eventual join cheaper[^1].

At the communication level, Spark's choice is binary: an all-to-all [shuffle](#shuffle) join, or a broadcast join that replicates the small side once so every node can then join locally with no further network traffic[^2]. Once a join has been routed to a shuffle-based strategy (broadcast wasn't used), Spark defaults to preferring sort-merge join over shuffle hash join, a preference controlled by `spark.sql.join.preferSortMergeJoin`[^3]. Since Spark 3.2, [Adaptive Query Execution](#aqe) (AQE), on by default, re-optimizes the physical plan mid-execution using runtime statistics gathered after the shuffle actually runs, rather than relying only on pre-execution estimates[^4].

<img class="light-only" src="diagrams/join-strategy.svg" alt="Decision tree for choosing a physical join operator: the equi-join test splits off the nested-loop strategies, then the broadcast-threshold and preferSortMergeJoin checks select broadcast hash, sort-merge, or shuffle hash join, with AQE able to promote sort-merge to broadcast at runtime.">
<img class="dark-only" src="diagrams/join-strategy.dark.svg" alt="Decision tree for choosing a physical join operator: the equi-join test splits off the nested-loop strategies, then the broadcast-threshold and preferSortMergeJoin checks select broadcast hash, sort-merge, or shuffle hash join, with AQE able to promote sort-merge to broadcast at runtime.">

## Reading it in the plan

That choice is legible before a job even runs. The deciding signal is the relation's size relative to `spark.sql.autoBroadcastJoinThreshold`, which defaults to `10485760` bytes (10 MB), unchanged since it was introduced in Spark 1.1.0 and still the documented default in Spark 3.5[^4][^5]. That comparison is driven by table/plan size statistics rather than a fresh scan of the data: Spark consults catalog statistics (collected via `ANALYZE TABLE`, inspectable through `DESCRIBE EXTENDED`) and the cost estimates shown in `EXPLAIN COST`[^4]. When those statistics are missing, `spark.sql.statistics.fallBackToHdfs` (default `false`) controls whether Spark falls back to on-disk file size to judge broadcast eligibility, and for partitioned tables without statistics Spark instead uses the `spark.sql.defaultSizeInBytes` placeholder[^5].

> **PySpark:** don't guess whether a join will broadcast. Call `df.explain(mode="cost")` to see the same size estimates Catalyst used to pick the strategy.

Because AQE re-optimizes at runtime, the physical join operator visible in a plan can change after execution starts. Two runtime-driven overrides are worth checking for in the Spark UI or an `EXPLAIN` plan: `spark.sql.adaptive.maxShuffledHashJoinLocalMapThreshold` (default `0`, disabled) can make AQE prefer shuffled hash join over sort-merge "regardless of the value of `spark.sql.join.preferSortMergeJoin`" whenever every post-shuffle partition stays under that threshold and above `spark.sql.adaptive.advisoryPartitionSizeInBytes`[^4]; separately, AQE can convert an already-planned sort-merge join into a broadcast hash join mid-execution when the runtime statistics of either join side turn out smaller than the adaptive broadcast threshold[^4].

Bucketing status is also visible directly in the physical plan: a shuffle-free bucketed join only appears once both sides are bucketed to the same count, at which point the `Exchange` nodes disappear entirely[^8]. This is demonstrated with 4 buckets on each side[^6] and with 16 buckets on each side, where the plan shows `SelectedBucketsCount: 16 out of 16` on both branches of the `SortMergeJoin`[^7]. A separate real-world account of eliminating a bucketed shuffle frames the same signal just as plainly: the giveaway is that "the right branch is missing an Exchange (i.e. shuffle)"[^8]. Removing the shuffle this way does not necessarily remove the sort phase: in the 16-bucket demo, a `Sort` operator still appears on each branch of the `SortMergeJoin` even with the `Exchange` gone[^7].

Whether Catalyst is reordering joins (rather than just individual operators) is also a config check: `spark.sql.cbo.enabled` and the separate `spark.sql.cbo.joinReorder.enabled` flag both default to `false`, so multi-way join reordering is off unless both are explicitly enabled[^5]. That's distinct from Catalyst's regular rule-based optimizations, which run regardless of those flags. For example, a filter written after a join in the DataFrame API was observed moved before the join (and pushed into the JDBC source) automatically, visible in the physical plan[^9].

## Costs the plan doesn't show

Picking a strategy is one thing; paying for it is another. Broadcasting isn't free on the driver side. Building a broadcast join replicates the small-side DataFrame to every worker, but that replication is preceded by collecting the DataFrame back to the driver first: an [oversized broadcast](#bottleneck-broadcast-sizing), whether chosen automatically or forced via a hint or `broadcast()` call, "can crash your driver node (because that collect is expensive)"[^2]. The shuffle-and-replicate nested loop (cartesian-style) strategy carries a related but distinct risk: because every partition is joined against every other partition, it has a high chance of data explosion[^1].

Bucketing's shuffle-free path also has a real tradeoff once bucket counts don't match exactly. Since Spark 3.1, `spark.sql.bucketing.coalesceBucketsInJoin.enabled` lets Spark coalesce the side with more buckets down to the smaller count, but only within a ratio bounded by `spark.sql.bucketing.coalesceBucketsInJoin.maxBucketRatio` (default `4`). Enabling it can still remove the shuffle, but it does so by cutting parallelism on the finer-grained side, and Spark's own docs note it "could possibly cause OOM for shuffled hash join" as a result[^5]. Outside that ratio, or with coalescing disabled, mismatched bucket counts get no free win at all: the join simply falls back to a normal shuffle.

## Forcing a strategy

When the automatic choice isn't the right one, Spark still lets you override it directly. Join hints force a specific strategy per relation, and Spark honors them even against its own size-based defaults:

- **BROADCAST** (also accepted as `BROADCASTJOIN`/`MAPJOIN`) forces a broadcast join with the hinted relation as the build side (broadcast hash if there's an equi-join key, broadcast nested loop otherwise), and this is honored "even if the size of table 't1' suggested by the statistics is above the configuration `spark.sql.autoBroadcastJoinThreshold`"[^4].
- **MERGE** forces a shuffle sort-merge join; it needs an equi-join on sortable keys and high cardinality to pay off, and is less prone to OOM than the hash-based options since it never builds an in-memory hash table[^1].
- **SHUFFLE_HASH** forces a shuffle hash join, supporting all join types on an equi-join key but, like MERGE, wanting high cardinality; it builds a per-partition hash table after the shuffle[^1].
- **SHUFFLE_REPLICATE_NL** forces the shuffle-and-replicate nested loop join, supporting inner and cartesian joins with equi or non-equi conditions[^1].

When both sides of a join carry conflicting hints, Spark resolves them by a fixed priority: BROADCAST over MERGE over SHUFFLE_HASH over SHUFFLE_REPLICATE_NL. If both sides carry the *same* BROADCAST or SHUFFLE_HASH hint, Spark still picks a build side based on join type and relation sizes[^4]. As with any hint, none of this is guaranteed: Spark won't honor a hinted strategy that structurally can't support the actual join type being performed[^4]. The threshold itself can also be turned off outright: setting `spark.sql.autoBroadcastJoinThreshold` to `-1` forces every join to fall back to shuffle sort-merge instead of ever considering broadcast[^3].

For repeated joins on the same key, bucketing both tables to the *same* bucket count removes the shuffle for free. To also remove the sort phase (not just the shuffle), the bucketed tables additionally need to be written pre-sorted on the join key, using `sortBy` alongside `bucketBy`; done that way, the merge phase has nothing left to do, since "the joined output is sorted ... because we saved the tables sorted in ascending order ... there's no need to sort during the `SortMergeJoin`," and the Spark UI shows the query going straight to `WholeStageCodegen` with no `Exchange` at all[^3].

> **PySpark:** `df.write.bucketBy(n, "key").saveAsTable(...)` drops the shuffle; add `.sortBy("key")` on both tables to drop the sort phase too.

Multi-way join reordering is a deliberate opt-in: enable `spark.sql.cbo.enabled` for cost-based statistics, then `spark.sql.cbo.joinReorder.enabled` for the reordering rule itself. `spark.sql.cbo.joinReorder.dp.threshold` caps the dynamic-programming enumeration at 12 joined nodes by default, and `spark.sql.cbo.joinReorder.dp.star.filter` applies star-join filter heuristics on top of it[^5]. A lighter-weight alternative that skips full CBO is `spark.sql.cbo.starSchemaDetection` (default `false`), which enables join reordering based on star-schema detection alone[^5].

For [skewed join keys](#bottleneck-skew), Spark offers two built-in alternatives to hand-rolled salting: AQE's skew-join handling (`spark.sql.adaptive.skewJoin.enabled`), which detects oversized shuffle partitions at runtime and splits them automatically, replicating if needed[^10][^5], and Databricks' declarative `SKEW` hint, which builds a skew-aware plan without any manual salting[^11]. Manual salting remains the fallback where neither is available: add a random salt column to the join key on both sides so a hot key spreads across many partitions (exploding the dimension side into one row per salt value and assigning a random salt on the fact side), then join on the composite `(key, salt)` pair[^12].

## Sources

[^1]: *High Performance Spark, 2nd Edition*, Karau, Polak & Warren, ch. 6
[^2]: *Spark: The Definitive Guide*, Chambers & Zaharia, ch. 8
[^3]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das, Lee, ch. 7
[^4]: [Performance Tuning — Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^5]: [Configuration — Spark](https://spark.apache.org/docs/latest/configuration.html)
[^6]: [Bucketing — The Internals of Spark SQL](https://books.japila.pl/spark-sql-internals/bucketing/)
[^7]: [The 5-Minute Guide to Using Bucketing in PySpark](https://luminousmen.com/post/the-5-minute-guide-to-using-bucketing-in-pyspark)
[^8]: [Bucket the Shuffle Out of Here](https://www.taboola.com/engineering/bucket-the-shuffle-out-of-here/)
[^9]: [Spark Tips: DataFrame API](https://luminousmen.com/post/spark-tips-dataframe-api)
[^10]: [SPARK-29544 — Optimize Skewed Join at Runtime](https://issues.apache.org/jira/browse/SPARK-29544)
[^11]: [Skew Join Hint](https://docs.databricks.com/aws/en/archive/legacy/skew-join)
[^12]: [Spark Tips: Partition Tuning](https://luminousmen.com/post/spark-tips-partition-tuning)
