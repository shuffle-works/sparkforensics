---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

The spill finding sizes the memory each task slot has. When a volume spill's task peak is near that share, it advises lowering `spark.executor.cores` and names the shuffle partition count that reaches 128 MiB per partition. Under AQE coalescing it also names `spark.sql.adaptive.coalescePartitions.minPartitionNum` when `spark.sql.adaptive.coalescePartitions.parallelismFirst` is on.
