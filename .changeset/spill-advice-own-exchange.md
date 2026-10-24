---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Partition-count advice no longer says AQE coalesced a stage's shuffle when the stage's exchange has no coalescing `AQEShuffleRead` over it, as with `repartition(n)`, and no longer blames AQE skew splits for the extra tasks of a stage whose exchange has no AQE read over it. Those stages point at their own partition count and executor memory, not `spark.sql.adaptive.advisoryPartitionSizeInBytes`.
