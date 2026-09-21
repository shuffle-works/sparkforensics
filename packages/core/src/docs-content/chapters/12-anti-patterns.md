# Anti-Patterns

Practitioner checklists on Spark performance converge on a recurring handful of mistakes
rather than exotic ones. Each entry below covers what the mistake is, how to detect it,
why it hurts, and how to fix it.

1. **Staying on the RDD API instead of DataFrame/Dataset**
    - **What:** Building jobs on the RDD API (or RDD-based MLlib) instead of the
      DataFrame/Dataset API.
    - **Detect:** Code that drives its logic through `.map`/`.filter` lambdas over RDDs, or
      that calls into the RDD-based MLlib API.
    - **Why:** RDDs are lambda-driven, so Spark cannot see inside the closures. It can't apply
      predicate pushdown, filter reordering, Adaptive Query Execution, or cost-based join
      reordering. The RDD-based MLlib API is in maintenance mode for the same reason.[^1]
    - **Fix:** Use the DataFrame/Dataset API so Catalyst can optimize the query plan.

2. **Reading CSV/JSON without an explicit schema**
    - **What:** Reading raw CSV or JSON files without supplying an explicit schema.
    - **Detect:** A read step that spends noticeable time before any real work starts, because
      Spark is inferring types from the data itself.
    - **Why:** Schema inference forces a full scan of the data just to determine types, and
      CSV/JSON don't support the column pruning, predicate pushdown, or stats-based file
      skipping that a columnar format does.[^1]
    - **Fix:** Supply an explicit schema, or prefer Parquet for analytical workloads, where column
      pruning, predicate pushdown, and stats-based file skipping work out of the box.[^1]

3. **Compressing input files with a non-splittable codec (GZIP)**
    - **What:** Storing input data as large GZIP files.
    - **Detect:** One task/executor taking far longer than the rest on a stage reading
      GZIP-compressed input, while other executors sit idle.
    - **Why:** A GZIP file can't be split across executors, so a single node has to decompress
      the whole file alone.[^1]
    - **Fix:** Use a splittable codec instead: Snappy, LZ4, or ZSTD.[^1]

4. **Storing data as JSON instead of a binary columnar/row format**
    - **What:** Persisting datasets as JSON rather than a binary columnar or row format.
    - **Detect:** Read-heavy jobs where a large, recurring share of stage time goes to parsing
      the same JSON structures on every read.
    - **Why:** JSON has to be re-parsed from text on every single read.[^2]
    - **Fix:** Store data as Avro, Parquet, Thrift, or Protobuf structs in a sequence file to
      avoid the repeated parsing cost.[^2]

5. **Not registering custom classes with Kryo**
    - **What:** Using Kryo serialization without registering the application's custom classes.
    - **Detect:** Larger-than-expected serialized record sizes, and poor efficiency when using a
      serialized cache storage level such as `MEMORY_SER`.
    - **Why:** Unregistered classes increase serialized-record size and hurt serialized cache
      storage levels.[^2]
    - **Fix:** Register the application's custom classes with Kryo.

6. **Calling `collect()` on a large DataFrame**
    - **What:** Materializing an entire DataFrame into driver memory with `collect()`.
    - **Detect:** A driver `OutOfMemoryError`, or a job that aborts once
      `spark.driver.maxResultSize` (default 1 GB) is exceeded. Spark also logs a warning once a
      single task's serialized result passes roughly 1 MB.[^3][^1]
    - **Why:** `collect()` gathers every `Row` from every partition into a single in-memory
      `Array` that lives entirely on the driver, not the cluster. The driver JVM has to hold
      the whole result set in its own heap.[^3][^4][^5][^6]
    - **Fix:** Use aggregations or `take(n)` instead of collecting the full result set.

      > **PySpark:** `toPandas()` performs the same driver-side collection as `collect()` for
      > Python users, so avoid it on large DataFrames too.[^6]

7. **Assuming `cache()` + `count()` guarantees the DataFrame stays fully cached**
    - **What:** Treating `df.cache(); df.count()` as a guarantee that the DataFrame remains
      fully persisted for later actions.
    - **Detect:** Later actions on a supposedly-cached DataFrame recompute from source instead
      of hitting the cache. There's no built-in visibility into how much of a DataFrame is
      still actually cached, so this typically only surfaces as unexpectedly slow
      recomputation.[^7]
    - **Why:** `count()` does force every partition to be computed and attempted for caching,
      unlike `take`/`limit`, which only touch the partitions they need.[^5][^7] But partitions
      can't be fractionally cached: if there isn't room for all of them, the ones that don't
      fit are silently dropped and recomputed on next access.[^5] Cached blocks also compete
      with execution for the same memory pool and can be evicted under pressure without
      warning, and caching is tied to the *analyzed* (pre-optimization) logical plan, so a
      semantically identical query with a different analyzed plan bypasses the cache entirely
      and recomputes from source.[^7] Losing an executor drops any cached block that wasn't
      stored with a replicated storage level like `MEMORY_AND_DISK_2`.[^7]
    - **Fix:** Keep using `.cache()` followed by `.count()` to force materialization, but don't
      assume that guarantees persistence (there's no built-in way to confirm how much of the
      DataFrame is actually cached[^7]), and use a replicated storage level if losing a cached
      partition to executor failure would be costly.

8. **Row-at-a-time Python UDFs**
    - **What:** Writing Python UDFs that operate one row at a time instead of vectorized Pandas
      UDFs.
    - **Detect:** A UDF-heavy stage where most of the time goes to serialization rather than
      actual computation.[^9]
    - **Why:** The overhead is serialization plus per-row JVM↔Python data movement, not raw
      Python interpreter speed. Row-at-a-time UDFs "suffer from high serialization and
      invocation overhead."[^8] RDD-era Python UDFs pay a *double* serialization cost: Java/Scala
      objects are serialized, then re-serialized to Python via `cloudpickle` and back on every
      call.[^9] A Databricks benchmark on a 10M-row DataFrame showed vectorized Pandas UDFs
      beating row-at-a-time UDFs "across the board, ranging from 3x to over 100x."[^8]
    - **Fix:** Use vectorized Pandas UDFs instead of row-at-a-time UDFs: once data is
      transferred via Arrow, there's no need to serialize/pickle it, since it's already in a
      format consumable by the Python process.[^5]

9. **Leaving `spark.sql.shuffle.partitions` at its default of 200**
    - **What:** Never tuning `spark.sql.shuffle.partitions` away from its default of 200 for
      wide transformations (`join`, `groupBy`, aggregations).
    - **Detect:** In the Spark UI Stages tab, too few partitions for the data size shows up as
      "Spill (Memory)" or "Spill (Disk)" entries against a stage; too many partitions for the
      data size shows up as a large task/stage count where each task's duration is dominated by
      scheduling and bookkeeping, often paired with a large number of tiny output files.[^10]
    - **Why:** 200 is a fixed default regardless of whether you're joining 5MB or 5TB.[^10][^11]
      Too few partitions means each one holds more data than fits comfortably in executor
      memory, which increases load per executor and leads to spills once partition size exceeds
      available memory.[^10] Too many partitions on a small dataset can shrink tasks to around
      ten rows each, so "most of your CPUs will just be sitting there doing nothing."[^10]
    - **Fix:** Increase `spark.sql.shuffle.partitions` if tasks are processing multiple GB each
      and spilling; decrease it if tasks finish in a couple of seconds and write tiny files. A
      rough starting target is 100–200 MB of data per task, tuned per dataset.[^10]

10. **Broadcasting a table that's too large**
    - **What:** Forcing or allowing a broadcast join on a table that's too large to broadcast
      safely.
    - **Detect:** A driver `OutOfMemoryError` during a broadcast join.
    - **Why:** The small side of the join has to be collected onto the driver before it can be
      broadcast to every executor. That collection step is the same driver-memory operation
      as `.collect()`, and it's what fails, not executor-side replication or a serialization
      timeout: "if you try to broadcast something too large, you can crash your driver node
      (because that collect is expensive)."[^4]
    - **Fix:** Use `spark.sql.autoBroadcastJoinThreshold` to control the maximum size Spark
      will broadcast, or increase driver memory.[^4]

11. **Reaching for `coalesce(1)` before every single-file write**
    - **What:** Always using `coalesce(1)` instead of `repartition(1)` when a single output
      file is needed.
    - **Detect:** The entire upstream stage (including filtering/transformation work that
      would otherwise run in parallel) collapses onto a single task/executor, leaving the
      rest of the cluster idle.
    - **Why:** `coalesce` is a narrow transformation, so it "causes the upstream partitions in
      the entire stage to execute with the level of parallelism assigned by coalesce," fusing
      all preceding work down to one task.[^6] `repartition` triggers a full shuffle instead,
      which inserts an explicit shuffle boundary so the upstream stage keeps its original
      parallelism.[^4][^6]
    - **Fix:** Use `repartition(1)` when there is meaningful upstream computation you don't
      want collapsed onto a single executor; reserve `coalesce(1)` for when the upstream stage
      is already cheap and paying for a shuffle would be wasted cost.[^6]

12. **Not verifying predicate pushdown is actually happening**
    - **What:** Assuming filters and column projections are pushed down to the data source
      without checking the physical plan.
    - **Detect:** Run `.explain()` and look at the `Scan` node for a `PushedFilters` marker.
      For example, `*Scan JDBCRel... PushedFilters: [*In(DEST_COUNTRY_NAME, [Anguilla,
      Sweden])]`. Column pruning is verified the same way: a `.select()` on one column should
      show a narrowed `ReadSchema` at the scan rather than a full-table scan.[^4]
    - **Why:** Spark pushes down simple filters (column equality, `IN`, `IS NULL`) to JDBC
      sources automatically, but anything with a computed column or cast won't push down and
      gets evaluated in Spark after the full read.[^1] Some sources also only partially handle
      a filter and leave Spark to re-evaluate it as a safety mechanism; that's still a "good"
      pushdown since the amount of data read is reduced.[^6]
    - **Fix:** Check `explain` output (paired with `printSchema`)[^6] for `PushedFilters` after
      writing a filter, and rewrite filters that use casts or computed columns as simple
      predicates where possible so they can push down.[^4][^1]

## Sources

[^1]: [The Apache Spark Optimization Checklist](https://luminousmen.com/post/the-apache-spark-optimization-checklist)
[^2]: [How to Tune Your Apache Spark Jobs (Part 2)](https://blog.cloudera.com/how-to-tune-your-apache-spark-jobs-part-2/)
[^3]: *Advanced Analytics with PySpark*, Tandon, Ryza, Laserson et al., ch. 2
[^4]: *Spark: The Definitive Guide*, Chambers & Zaharia, chs. 5, 8, 9, 18, 19
[^5]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das & Lee, chs. 3, 5, 7
[^6]: *High Performance Spark, 2nd Edition*, Karau, Polak & Warren, chs. 5, 7
[^7]: [Explaining the Mechanics of Spark Caching](https://luminousmen.com/post/explaining-the-mechanics-of-spark-caching)
[^8]: [Introducing Vectorized UDFs for PySpark](https://www.databricks.com/blog/2017/10/30/introducing-vectorized-udfs-for-pyspark.html)
[^9]: [Spark Tips: DataFrame API](https://luminousmen.com/post/spark-tips-dataframe-api)
[^10]: [Spark Partitions](https://luminousmen.com/post/spark-partitions)
[^11]: [Configuration — Spark](https://spark.apache.org/docs/latest/configuration.html)
