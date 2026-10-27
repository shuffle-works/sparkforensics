---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

A new `mergeRewrite` finding (tag `PLAN`) flags a Delta MERGE that rewrote mostly unmodified rows or skipped few files. It fires when the MERGE rewrote at least 100,000 unmodified target rows and at least twice the rows it changed, or when it kept at least 90% of 8 or more target files after skipping while its changes touched at most half of the partitions it scanned. Its advice is to filter the MERGE source to changed rows, repeat the partition range in the MERGE condition, and check the target's file layout. `--thresholds` changes `minCopiedRows`, `minCopiedToChangedRatio`, `minTargetFiles`, `minFilesKeptShare` and `maxTouchedPartitionShare`.
