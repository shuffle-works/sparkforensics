---
'sparkforensics-cli': minor
'sparkforensics-mcp': minor
'sparkforensics-server': minor
'sparkforensics-web': minor
---

Spill findings name where the spill sits. Each operator carries its plan `arguments` (a sort's keys) and a sort's `global` flag. Each exchange carries its `partitioning`, `partitions` and `origin`, and the finding says when the partitioning is the job's own `repartition(n)`, so `spark.sql.shuffle.partitions` does not change it. `evidence.sqlDescription` holds the description of the SQL execution, and the wide-rows sentence gives the column count.
