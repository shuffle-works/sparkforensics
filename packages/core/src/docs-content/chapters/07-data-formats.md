# Data Formats

## How Parquet and ORC lay out data

Parquet and ORC are both self-describing, columnar file formats for storing Spark's structured data[^1]. They're closer than they are different: *Spark: The Definitive Guide* frames the choice as "for the most part, they're quite similar; the fundamental difference is that Parquet is further optimized for use with Spark, whereas ORC is further optimized for Hive"[^1], and notes that ORC "has no options for reading in data because Spark understands the file format quite well"[^1]: Spark treats it as a format it understands natively rather than one with extra read-side knobs.

Both formats group rows into chunks (row groups in Parquet, stripes in ORC), each holding every column's data for that slice, with a footer or file-level metadata section recording where each chunk lives on disk. Parquet's `FileMetaData` footer records the offset and size of every row group and column chunk, and "readers are expected to first read the file metadata to find all the column chunks they are interested in. The column chunks should then be read sequentially"[^2]. Because compression is applied per column chunk rather than as one continuous stream over the whole file, a reader can seek straight to a row group's footer-recorded offset and decode just that chunk, which is exactly why Parquet files compressed with Snappy stay splittable even though the Snappy stream format itself provides no split points: it has "no entropy encoder backend nor framing layer -- the latter is assumed to be handled by other parts of the system"[^3].

<img class="light-only" src="diagrams/columnar-layout.svg" alt="A columnar file's footer holds row-group offsets and per-column min/max statistics that let a reader skip row groups whose stats exclude the predicate.">
<img class="dark-only" src="diagrams/columnar-layout.dark.svg" alt="A columnar file's footer holds row-group offsets and per-column min/max statistics that let a reader skip row groups whose stats exclude the predicate.">

Both formats also carry the statistics that later drive predicate pushdown. Parquet records min/max values per column chunk, plus an optional page-level `ColumnIndex` that lets a reader binary-search ordered columns for matching pages[^4], and optional Bloom filters for columns whose cardinality is too high for a dictionary to be practical[^5]. ORC's `ColumnStatistics` protobuf records row count and, for most primitive types, min/max (plus sum for numeric types); from Hive 1.1.0 it also records a `hasNull` flag used specifically by ORC's predicate pushdown to answer `IS NULL` queries[^6]. ORC layers this at two granularities: a `RowIndexEntry` per row group (10,000 rows by default), kept at the front of each stripe so it's read only when pushdown or seeking is actually needed[^7], and file-level `StripeStatistics` that let whole stripes be skipped by predicate pushdown[^8]. ORC also supports Bloom filters (Hive 1.2.0+), but only evaluates them against row groups that already passed the min/max row-index check first: a second-stage filter, not an independent one[^7].

On compression: Parquet defaults to Snappy, while ORC's default has been Zstd since Spark 2.3.0[^9]. Zstandard's own manual describes it as "a fast lossless compression algorithm, targeting real-time compression scenarios at zlib-level and better compression ratios," offering regular levels 1–22 plus negative levels that trade ratio for speed[^10]. Spark exposes the level directly through `spark.io.compression.zstd.level` (default `1`)[^9], along with `spark.io.compression.zstd.workers` for parallel compression threads (default `0`, since 4.0.0) and `spark.io.compression.zstd.bufferSize` (default 32k)[^9].

Parquet has one more structural knob: `parquet.writer.version`. Version 2 changes the on-disk page-header encoding, and the spec is explicit that this is a forward-*incompatible* change: "a reader that only understands `DataPageHeader` cannot parse `DataPageHeaderV2` pages"[^11]. The spec also flags that the file's own version marker "has historically been used inconsistently: writers populate 1 or 2 without a consistent relationship to the features actually used"[^11], so the marker itself isn't a reliable way to tell which page format a file actually contains.

## What shows up at read time

A file's layout shapes the job the moment Spark reads it. Spark's file readers derive partition counts from file metadata rather than from a fixed rule: "for structured formats like Parquet, ORC, or Avro, Spark actually reads the metadata (footers, row groups, that kind of thing) and tries to slice the file in a way that makes sense. Often you'll see one partition per row group, though Spark may merge or split depending on file sizes and configs"[^12]. A concrete case: a single 30 GB Parquet file with 300 row groups gets split into exactly 300 partitions[^12]. So a surprising partition count for a given file is usually explained by its row-group layout, separately from `spark.sql.files.maxPartitionBytes` (128 MB by default) and its `maxPartitionNum`/`minPartitionNum` companions, which govern splitting for file-based sources generally[^13].

The [small-files problem](#bottleneck-small-files) shows up as metadata overhead rather than raw I/O cost: "when you're writing lots of small files, there's a significant metadata overhead that you incur managing all of those files. Spark especially does not do well with small files"[^1]. At the other extreme, oversized or misaligned row groups show up as lost locality: the Parquet spec's rationale for matching block size to row-group size is that "since an entire row group might need to be read, we want it to completely fit on one HDFS block"[^14]. A row group straddling a block boundary can't get that benefit.

Raw (non-Parquet) gzip or zip source files reveal themselves as a single-executor bottleneck at read time, visible as one task doing dramatically more work than the rest of its stage: Spark "needs to download the whole file on one executor, unpack it on just one core, and then redistribute the partitions to the cluster nodes"[^15].

Version and schema mismatches surface as read failures rather than silent corruption. A file written with `parquet.writer.version=2` can't be parsed by an older Spark version, or a non-Spark engine such as Hive or Impala, if that reader only implements the original `DataPageHeader`[^11]. *Spark: The Definitive Guide* frames this as a general risk: "you can still encounter problems if you're working with incompatible Parquet files. Be careful when you write out Parquet files with different versions of Spark (especially older ones) because this can cause significant headache"[^1].

## What the layout buys you

Those read-time symptoms trace back to specific tradeoffs in the layout. Splittability is what decides whether a file can be processed in parallel at all. A non-splittable raw compressed source file forces Spark onto a single core for the whole download-and-unpack step before it can redistribute anything: "as you can imagine, this becomes a huge bottleneck in your distributed processing"[^15]. Parquet sidesteps this at the container level: because its footer records row-group and column-chunk offsets independently of whichever codec compressed the bytes inside them, a task can seek and decode a row group on its own, so even a non-splittable codec like Snappy doesn't cost the file its parallelism[^2][^3].

Row-group and block-size alignment governs the same kind of locality at a coarser grain. The spec recommends large row groups, 512 MB–1 GB, "because larger row groups allow for larger column chunks which makes it possible to do larger sequential IO," at the cost of more write-side buffering, paired with a block size sized the same way; its own worked example is "1GB row groups, 1GB HDFS block size, 1 HDFS block per HDFS file"[^14].

The statistics both formats carry are what predicate pushdown runs against. Spark plans queries directly off "statistics that Spark reads directly from the underlying data source, like the counts and min/max values in the metadata of Parquet files"[^16], gated by `spark.sql.parquet.filterPushdown` (default `true` since Spark 1.2.0) and, for ORC, `spark.sql.orc.filterPushdown` (default `true` since 1.4.0)[^17][^18]. A more aggressive option, `spark.sql.parquet.aggregatePushdown` (default `false`, since 3.3.0), pushes `MIN`, `MAX`, and `COUNT` down to Parquet's footer statistics directly, and throws if the needed statistic is missing from a file's footer[^17]. Skipping a row group or stripe this way means its bytes are never read off disk, which beats any amount of post-read filtering.

Small files cost more in metadata management than their data volume would suggest, and Spark "especially does not do well" with them[^1]. On the scheduling side, Spark's tuning guide notes it "can efficiently support tasks as short as 200 ms" because it reuses one executor JVM across many tasks and has low task-launch cost, while separately recommending "2-3 tasks per CPU core in your cluster"[^19], which implies [scheduling overhead](#bottleneck-tiny-tasks) only becomes proportionally significant once tasks (and the files behind them) shrink below roughly that 200 ms floor.

Compression choice trades CPU against I/O and storage. Once I/O stops being the bottleneck, paying a codec's decompression cost is a net loss: "uncompressed files are clearly outperforming compressed files. This is because uncompressed files are I/O bound, and compressed files are CPU bound, but I/O is good enough here"[^15]. Bzip2 illustrates the opposite failure mode: it's splittable, but compresses so aggressively that "you get very few partitions and therefore they can be poorly distributed"[^15].

Writer-version and schema changes matter because they fail at read time, for whoever reads the data next (not at write time, for whoever wrote it). A `parquet.writer.version=2` file is simply unreadable by any engine that only understands the original page header[^11]. Schema drift has its own correctness angle: for [Delta Lake](#table-formats) tables, adding a column via `mergeSchema` causes existing rows, when read back, to have that new column's value read as `NULL`[^20], a defined outcome, but one that changes what a downstream query sees for rows written before the schema changed.

## Choosing and tuning the format

A few defaults cover most cases despite those tradeoffs. Default to Parquet. Reach for ORC specifically when the same data also has to serve Hive consumers or existing Hive ORC tables, where ORC is the better-optimized target[^1].

Size row groups and the underlying filesystem block together, not independently. The Parquet spec's own recommended setup is 1 GB row groups paired with a 1 GB HDFS block size, one block per file[^14]. Leave `spark.sql.files.maxPartitionBytes` (128 MB default) and its `maxPartitionNum`/`minPartitionNum` companions for the general file-splitting case, but expect row-group boundaries (not these settings) to be what actually decides partition count for row-group-oriented formats[^13][^12].

Leave predicate pushdown on: `spark.sql.parquet.filterPushdown` and `spark.sql.orc.filterPushdown` both default to `true` already[^17][^18], so the main action is not disabling them, plus considering `spark.sql.parquet.aggregatePushdown` when a workload is dominated by `MIN`/`MAX`/`COUNT` over Parquet sources with complete footer statistics[^17].

Cap output file size directly instead of letting the small-files problem accumulate: `maxRecordsPerFile`, introduced in Spark 2.2, targets an optimum file size by capping the number of records written per file, e.g. `df.write.option("maxRecordsPerFile", 5000)`[^1].

Pick a compression codec based on the actual bottleneck. Parquet's default, Snappy, favors speed; ORC has already defaulted to Zstd since Spark 2.3.0[^9], and at least one optimization checklist recommends overriding Parquet's default to Zstd as well[^21]. Zstd's level is tunable through `spark.io.compression.zstd.level`: higher levels buy better compression "at the expense of more CPU and memory"[^9]. Avoid feeding Spark large raw `.gz`/`.zip` source files directly (unpack them before loading), since the non-splittability lives in the raw container format rather than in gzip itself; the same *Definitive Guide* that warns about raw gzip files elsewhere still recommends Parquet with gzip compression once gzip is wrapped inside Parquet's row-group container[^1].

Treat `spark.sql.parquet.mergeSchema` (default `false`) as opt-in rather than default-on: enabling it "merges schemas collected from all data files," instead of trusting a single summary file or a random file's schema[^22], useful for evolving schemas, but it means every file in the dataset gets scanned for its schema. For Delta tables specifically, remember that `mergeSchema`-added columns read back as `NULL` on pre-existing rows[^20] before relying on it for a backfill.

Don't flip `parquet.writer.version` to `2` without confirming every downstream reader of that data (an older Spark version, Hive, Impala, or anything else touching the files) actually supports `DataPageHeaderV2` first; it's a forward-incompatible page-format change, not an additive one[^11][^1].

## Sources

[^1]: *Spark: The Definitive Guide*, Chambers & Zaharia, ch. 9
[^2]: [Parquet File Format: File Metadata and Row Groups](https://parquet.apache.org/_print/docs/file-format/)
[^3]: [Snappy Compressed Format Description](https://github.com/google/snappy/blob/main/format_description.txt)
[^4]: [Parquet File Format: Column Index](https://parquet.apache.org/_print/docs/file-format/)
[^5]: [Parquet File Format: Bloom Filter](https://parquet.apache.org/docs/file-format/bloomfilter/)
[^6]: [ORC Specification v1: Column Statistics](https://orc.apache.org/specification/ORCv1/)
[^7]: [ORC Specification v1: Row Index and Bloom Filters](https://orc.apache.org/specification/ORCv1/)
[^8]: [ORC Specification v1: Stripe Statistics](https://orc.apache.org/specification/ORCv1/)
[^9]: [Configuration: Spark](https://spark.apache.org/docs/latest/configuration.html)
[^10]: [Zstandard Manual](https://facebook.github.io/zstd/zstd_manual.html)
[^11]: [Parquet File Format: Data Pages (V1/V2)](https://parquet.apache.org/_print/docs/file-format/)
[^12]: [How Spark Determines Partitions for a File](https://luminousmen.com/post/spark-partitions)
[^13]: [Performance Tuning: Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^14]: [Parquet File Format: Row Group Size](https://parquet.apache.org/_print/docs/file-format/)
[^15]: [Spark Tips: Don't Collect Data on Driver](https://luminousmen.com/post/spark-tips-dont-collect-data-on-driver)
[^16]: [Performance Tuning: Spark SQL, DataFrames and Datasets Guide](https://spark.apache.org/docs/latest/sql-performance-tuning.html)
[^17]: [Configuration: Spark](https://spark.apache.org/docs/latest/configuration.html)
[^18]: [Configuration: Spark](https://spark.apache.org/docs/latest/configuration.html)
[^19]: [Spark Tuning Guide: Level of Parallelism](https://spark.apache.org/docs/latest/tuning.html)
[^20]: *Learning Spark, 2nd Edition*, Damji, Wenig, Das & Lee, ch. 9
[^21]: [The Apache Spark Optimization Checklist](https://luminousmen.com/post/the-apache-spark-optimization-checklist)
[^22]: [SQLConf.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/sql/catalyst/src/main/scala/org/apache/spark/sql/internal/SQLConf.scala)
