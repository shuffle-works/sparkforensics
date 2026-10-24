---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Partition-count advice no longer says AQE coalesced a stage's shuffle or blames AQE skew splits for its extra tasks, when the stage's exchange has no `AQEShuffleRead` over it, as with `repartition(n)`. Those stages point at their own partition count and executor memory, not `spark.sql.adaptive.advisoryPartitionSizeInBytes`.
