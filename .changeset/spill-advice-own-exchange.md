---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Partition-count advice no longer says AQE coalesced a stage's shuffle when the plan shows it did not. A stage whose exchange has no coalescing `AQEShuffleRead` over it (a `repartition(n)` exchange never gets one) is sized by the job, so the spill, tiny-task, slow-stage, low-parallelism and shuffle findings point at the stage's own partition count and executor memory instead of `spark.sql.adaptive.advisoryPartitionSizeInBytes`. A stage with a coalescing read keeps the advisory-size advice.
