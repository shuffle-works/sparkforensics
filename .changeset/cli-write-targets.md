---
"sparkforensics-cli": minor
---

The JSON report lists the run's SQL write targets. `writeTargets.writes` has one row per write command (Hadoop file, Hive, CTAS, `SaveIntoDataSourceCommand`, Delta and DataSource V2 writes such as Iceberg's) with its `command`, `kind` (`path` or `table`), `target`, `outputRows` and the raw plan string. A target that cannot be parsed, or that Spark cut short, is `null` with the raw string kept, never a partial path; a write-like node outside the known list is reported as unrecognized. `executionsWithoutPlan` lists SQL executions whose plan the log lacks. Writes made outside SQL do not appear in the event log and are not covered.
