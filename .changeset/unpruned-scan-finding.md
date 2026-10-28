---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

A new `unprunedScan` finding (tag `PLAN`, info, low confidence) flags a scan of a partitioned table that filters the rows it reads but has no partition filter. It fires when the scan reads at least 2 partitions and 1 GiB with an empty `PartitionFilters` and a row filter beyond null checks. The plan does not name the partition columns, so the finding asks you to confirm which columns partition the table. Its evidence holds the table, the partitions read and the filters. `--thresholds` changes `minBytesRead` and `minPartitionsRead`.
