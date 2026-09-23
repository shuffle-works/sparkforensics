# Small Files

<span class="tag">SMALLFILES</span>

## What it is

The small-files problem is the cost of managing a large count of tiny files. Writing many
small files runs up significant metadata overhead, and Spark handles that pattern badly;
distributed filesystems such as HDFS handle it badly too, which is why it earned the name
"small file problem"[^1]. The same trap shows up on the read side. Push
`spark.sql.files.maxPartitionBytes` (default 128 MB, aligned to the [Parquet](#data-formats) block size)
too low and Spark carves the input into many small partition files, piling on disk I/O and
the filesystem overhead of opening, closing, and listing directories, all of which are slow
on a distributed store[^2][^3].

Spark writes one file per output partition, so a job left with 200 partitions writes 200
files and one left with 3000 writes 3000, even when many of those files hold only a handful
of rows. That count then punishes every downstream job forced to read thousands of tiny
files[^4]. The opposite extreme is not free either: files that are too large make it
inefficient to read a whole block when you only need a few rows[^5].

## How it's detected

Each SQL plan node carries file-count and file-size metrics Spark reports directly:
`number of files read`/`size of files read` on the read side, `number of written
files`/`written output` on the write side. A node reads as a small-files problem once
its file count on a given side is high and the resulting average file size is small.

| Signal (per plan node, checked separately for read and write) | Fires when |
|---|---|
| File count | > 100 |
| Average file size (bytes ÷ file count) | < 3 MB |

Both conditions have to hold together, so a node with thousands of files that are each
big enough, or a handful of genuinely tiny ones, doesn't register. The signal comes
entirely from those file-count and file-size metrics, independent of
`spark.sql.files.maxPartitionBytes`.

## Why it matters

Every extra file is another open, close, and directory-list operation, and on a distributed
filesystem those are not cheap[^2]. The count compounds downstream: a stage that scatters
3000 tiny files hands the next job 3000 files to read back, so the metadata tax is paid twice
over[^4]. None of it is a single dramatic failure. The waste is spread thin across the file
count, which is exactly why it goes unnoticed until listing and I/O start to dominate.

## How to fix it

Repartition right before the write so the output lands in fewer, better-sized files.

- `coalesce()` is a shuffle-free merge: it fuses existing partitions with no data movement,
  so `df.coalesce(100).write.parquet(...)` collapses 3000 tiny files into 100 reasonable
  ones[^4]. It does not rebalance, though, so uneven inputs stay uneven once lumped together,
  and pushing it to `coalesce(1)` kills parallelism by forcing one executor to do all the
  work[^4].
- `repartition()` is a full reshuffle that buys even distribution at the cost of that
  [shuffle](#shuffle). Reach for it when the distribution itself needs fixing, not just the file
  count[^4].

> **PySpark:** both are one-line calls on a DataFrame: `df.coalesce(100)` for a shuffle-free
> merge, or `df.repartition(100)` when the data also needs rebalancing.

```python
# Collapse many tiny output files without a shuffle (distribution already even)
df.coalesce(100).write.parquet(path)

# Full reshuffle to a target count when the distribution itself needs fixing
df.repartition(100).write.parquet(path)
```

For runtime control, [Adaptive Query Execution](#aqe) can merge tiny shuffle partitions on its own.
With `spark.sql.adaptive.enabled` and `spark.sql.adaptive.coalescePartitions.enabled` (default
true) set, AQE coalesces contiguous shuffle partitions toward
`spark.sql.adaptive.advisoryPartitionSizeInBytes` (default 64 MB)[^4][^5]. Just mind the
scope: AQE only engages after the first shuffle, so it fixes shuffle-output partition counts
but will not repair input-side partitioning or a bad file layout on disk[^6].

## Confidence

The core inference, that one output file per partition times a high
partition count yields many tiny files, is grounded directly in Spark's write behavior[^4],
and the mitigation levers (`coalesce()`, `repartition()`, and AQE coalescing) are documented
Spark features[^4][^5].

## Limitations / false-positive risk

A high file count can be perfectly legitimate: partitioned output deliberately fans data
across many files by partition column, so a large count there is by design, not a defect.
And AQE coalescing is not a cure-all here, since it only affects post-shuffle partitions and
leaves the input file layout untouched[^6]. The signal reflects the shape, not intent, so
confirm the write is not an intended partitioned layout before acting.


## Related

- **Partition sizing:** [Partitioning](#partitioning)
- **Too many small tasks:** [Tiny Tasks](#bottleneck-tiny-tasks)

[^1]: *Spark: The Definitive Guide*, Chambers & Zaharia, ch. 19
[^2]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das, Lee, ch. 7
[^3]: [SQLConf.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/sql/catalyst/src/main/scala/org/apache/spark/sql/internal/SQLConf.scala)
[^4]: [Spark Partitions](https://luminousmen.com/post/spark-partitions)
[^5]: [Performance Tuning (Spark SQL, DataFrames and Datasets Guide)](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^6]: [The Apache Spark Optimization Checklist](https://luminousmen.com/post/the-apache-spark-optimization-checklist)
