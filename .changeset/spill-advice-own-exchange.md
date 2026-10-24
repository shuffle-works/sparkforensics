---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Partition-count advice no longer says AQE coalesced a stage's shuffle when the stage's exchange has no coalescing `AQEShuffleRead` over it, as with `repartition(n)`. Those stages point at their own partition count and executor memory, not `spark.sql.adaptive.advisoryPartitionSizeInBytes`.
