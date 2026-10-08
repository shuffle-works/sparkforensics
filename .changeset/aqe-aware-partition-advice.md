---
"@sparkforensics/core": patch
---

Partition-count advice on tiny-task, spill and slow-stage findings now names the lever that sized the stage: `spark.sql.shuffle.partitions` when the stage ran that many tasks, AQE's advisory partition size and `parallelismFirst` when AQE coalesced it, and the stage's own `repartition(n)` or RDD parallelism otherwise. Slow-stage advice no longer offers `spark.default.parallelism`.
