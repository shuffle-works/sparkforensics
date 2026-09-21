# Table Formats

## The knobs these formats share

[Parquet and ORC](#data-formats) stop at the file. A lakehouse *table format* wraps a directory of Parquet files with a transactional metadata layer that tracks which files belong to the table right now, so engines get ACID commits, time travel, schema evolution, and row-level updates over plain columnar files. The three in wide use are Delta Lake, Apache Iceberg, and Apache Hudi. They solve the same problems and differ mostly in mechanism, and the tuning knobs that matter fall into a handful of dimensions.

**File sizing.** All three fight the small-files problem, but at different points in the write. Delta Lake does not size files during the write by default; its `OPTIMIZE` command bin-packs already-written small files into larger ones, available since Delta Lake 1.2.0[^1]. Iceberg rewrites files after the fact through its `rewrite_data_files` procedure, whose default `binpack` strategy coalesces small files[^2]. Hudi treats correct sizing at write time as "a critical design decision": auto-sizing targets a 120 MB Parquet base file (`hoodie.parquet.max.file.size`) and pads any existing file at or below the 100 MB small-file limit (`hoodie.parquet.small.file.limit`) with new records rather than opening a fresh file[^3].

**Compaction.** Delta's `OPTIMIZE` bin-packing is the compaction path, run manually or, since Delta Lake 3.1.0, as auto compaction that runs synchronously right after a write succeeds[^1]. Iceberg uses `rewrite_data_files` as a stored procedure invoked from Spark SQL[^2]. Hudi splits the job in two: *compaction* applies only to Merge-on-Read tables and merges the row-based delta logs back into base files (async by default, or inline via `hoodie.compact.inline = true`), while *clustering* is a separate data-layout service that stitches small files together[^4][^5].

**Clustering.** To co-locate rows that are queried together, Delta Lake offers Z-Ordering via `OPTIMIZE table ZORDER BY (cols)`; its effectiveness drops with each added column and it is not idempotent, since each run reclusters all files in the partition[^1]. Delta also documents liquid clustering as a separate feature[^1]. Iceberg clusters through `rewrite_data_files` with `strategy => 'sort'` and a `sort_order` argument, including a `zorder(c1,c2)` form[^2]. Hudi clustering rewrites file groups sorting by `hoodie.clustering.plan.strategy.sort.columns`[^5].

**Metadata and manifest overhead.** Delta records each change as a JSON commit in the transaction log and periodically compacts those commits into a Parquet checkpoint so readers reconstruct state without replaying every commit; checkpoints can be split multi-part (default 50,000 actions per part), and since Delta 3.0 log-compaction files aggregate a commit range to cut checkpoint frequency[^1]. Iceberg writes a new metadata JSON file per change, tracks the manifests for each snapshot in a manifest list written fresh on every commit, and splits large tables across multiple manifests so query planning parallelizes[^6]. Hudi records every write and table-service action as an instant on a timeline, with clustering and compaction writing their plans there before executing[^5][^4].

**Snapshot and version expiry.** Delta reclaims storage with `VACUUM`, which deletes data files past a retention threshold (default 7 days) but never log files; log files are pruned automatically after checkpoints, with a 30-day default set by `delta.logRetentionDuration`[^7]. Iceberg's `expire_snapshots` removes old snapshots and the files only they referenced (`older_than` default 5 days, `retain_last` default 1), and `remove_orphan_files` sweeps unreferenced files (`older_than` default 3 days)[^2]. Hudi's cleaner runs automatically after each commit; the default `KEEP_LATEST_COMMITS` policy retains `hoodie.clean.commits.retained` commits (default 10)[^8].

**Row-level deletes: merge-on-read vs copy-on-write.** By default, deleting one row in a Delta table rewrites the whole Parquet file that holds it. Deletion vectors avoid that by marking rows removed in a side file and applying the marks at read time; support landed incrementally (DELETE in 2.4.0, UPDATE in 3.0.0, on by default since 3.1.0)[^9]. Iceberg took a spec-versioned route: v2 adds position and equality delete files, and v3 replaces position deletes with per-file deletion-vector bitmaps stored in the Puffin format[^6]. Hudi frames the same trade-off as two table types: Copy-on-Write rewrites a base file on every change (fast reads, slower writes), while Merge-on-Read appends changes to log files merged at query time and compacted later (fast writes, some read cost)[^10].

## Where these problems show up

Each of those knobs fails in its own recognizable way. The symptoms are the same ones the [Data Formats](#data-formats) and [Small Files](#bottleneck-small-files) pages describe, read through the table's own metadata. A table accumulating many sub-target files is a sizing problem: Hudi's own guidance ties small files to more tasks, more per-file open/close cost, and cloud object-store request-rate limits that trip because at least one request is issued per file regardless of size[^3].

Growing metadata is the second signal. Iceberg snapshots and metadata JSON files accumulate until expiry runs, and Iceberg recommends `expire_snapshots` specifically to keep metadata size small on top of freeing data files[^6]. Delta's commit log grows until checkpoints and log compaction absorb it[^1]. Hudi's timeline lengthens with every commit, clean, cluster, and compaction[^5]. Delta's `deltaTable.history()` surfaces the per-commit version, timestamp, and operation for inspecting that growth[^1].

Read amplification is the third. On a Merge-on-Read Hudi table, uncompacted delta logs are merged at query time, so a table that has not compacted recently reads more slowly[^4]. The Iceberg equivalent is a data file with many stacked position/equality delete files that a scan must apply[^6].

## What each dimension costs

Those symptoms aren't cosmetic. Small files cost more in metadata and scheduling than their bytes suggest: a query scans many files for the same data, each file adds fixed overhead, and on object storage the per-file request pattern raises the odds of hitting per-prefix rate limits[^3]. That is exactly the tension the compaction and clustering services exist to resolve, since ingestion favors many small files for low latency while queries favor fewer large ones[^3].

Metadata overhead is a planning tax. More data files mean more manifest entries, and small files inflate that metadata disproportionately and slow query planning, which is why Iceberg exposes `rewriteManifests` and compaction to cut it[^6]. Unbounded snapshot and metadata retention keeps that footprint growing until expiry is run[^6].

Clustering decides how much data a query skips. Delta's Z-Ordering co-locates related values so data-skipping can prune more files, dramatically reducing bytes read[^1]. The retention settings carry a correctness edge too: once Delta `VACUUM` runs, time travel to a version older than the retention window is gone[^7], and Iceberg warns that running `remove_orphan_files` with too short an interval can delete in-flight files and corrupt the table[^6].

## Tuning each dimension

Each dimension has a matching maintenance habit that keeps its cost down. Compact on a schedule. For Delta, run `OPTIMIZE` (optionally scoped with a `WHERE` partition predicate) or enable auto compaction on 3.1.0+[^1]. For Iceberg, call `rewrite_data_files`[^2]. For Merge-on-Read Hudi, let async compaction run or force it inline with `hoodie.compact.inline = true`, and use clustering to consolidate small files independently of it[^4][^5].

Cluster the columns you filter on. Use Delta `OPTIMIZE ... ZORDER BY (cols)` on a few high-cardinality predicate columns[^1], Iceberg `rewrite_data_files(strategy => 'sort', sort_order => '...')` or its `zorder(...)` form[^2], or Hudi clustering with `hoodie.clustering.plan.strategy.sort.columns`[^5].

Expire aggressively but safely. Run Delta `VACUUM` (keeping the 7-day floor unless you have a reason to override it, since the safety check exists to protect concurrent readers)[^7], Iceberg `expire_snapshots` plus periodic `remove_orphan_files` with an interval longer than your longest in-flight write[^6], and tune Hudi's cleaner via `hoodie.clean.commits.retained`[^8].

Match the delete strategy to the workload. Enable Delta deletion vectors (`ALTER TABLE ... SET TBLPROPERTIES('delta.enableDeletionVectors' = true)`) so DML marks rows instead of rewriting files, remembering the marks are applied physically only on `OPTIMIZE` or `REORG TABLE ... APPLY (PURGE)`[^9]. On Iceberg, prefer merge-on-read deletes for update-heavy tables and compact the delete files[^6]. On Hudi, pick Copy-on-Write for read-heavy tables and Merge-on-Read for write-heavy or near-real-time ingestion[^10].

## Sources

[^1]: [Delta Lake: Optimizations (OSS)](https://docs.delta.io/latest/optimizations-oss.html)
[^2]: [Apache Iceberg: Spark Procedures](https://iceberg.apache.org/docs/latest/spark-procedures/)
[^3]: [Apache Hudi: File Sizing](https://hudi.apache.org/docs/file_sizing/)
[^4]: [Apache Hudi: Compaction](https://hudi.apache.org/docs/compaction/)
[^5]: [Apache Hudi: Clustering](https://hudi.apache.org/docs/clustering/)
[^6]: [Apache Iceberg: Maintenance](https://iceberg.apache.org/docs/latest/maintenance/) and [Table Spec](https://iceberg.apache.org/spec/)
[^7]: [Delta Lake: Table Utility Commands](https://docs.delta.io/latest/delta-utility.html)
[^8]: [Apache Hudi: Cleaning](https://hudi.apache.org/docs/cleaning/)
[^9]: [Delta Lake: Deletion Vectors](https://docs.delta.io/latest/delta-deletion-vectors.html)
[^10]: [Apache Hudi: Table Types](https://hudi.apache.org/docs/table_types/)
