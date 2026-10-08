---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Detectors judge each run against the Spark configuration that applied to it. Findings that cite or suggest a setting change wording or remediation on runs where the effective value differs from the old assumption.

- Defaults come from Spark's own sources by version for every property a detector reads or suggests, instead of four hard-coded keys. A Spark 4.0 or later run now uses a speculation multiplier of 3 and quantile of 0.9, where earlier releases use 1.5 and 0.75.
- A finding scoped to one SQL execution (`skew`, `straggler`, `shuffle`, `partitionSizing`, `underBroadcast`, `overBroadcast`) reads that execution's settings from `SQLExecutionStart.modifiedConfigs`, so a job that sets `spark.sql.shuffle.partitions`, the broadcast threshold or the AQE switches with `spark.conf.set` is judged against what it set. A remediation the query already applied is left out.
- `speculationWaste`, `slowHost` and speculative-attempt `straggler` recommendations name the run's effective speculation trigger, for example "a task running over 3x the median is relaunched once 90% of the stage's tasks have finished".
