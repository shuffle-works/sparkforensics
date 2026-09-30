---
"sparkforensics-cli": minor
---

The JSON report lists the run's SQL write targets. `writeTargets.writes` has one row per write command (Hadoop file, Hive, CTAS, `SaveIntoDataSourceCommand`, Delta and DataSource V2 writes such as Iceberg's, table DDL and procedure calls) with its `command`, `kind` (`path`, `table`, `unqualifiedTable` for a V2 name with no catalog part, or `jdbcTable`), `target`, `outputRows` and the raw plan string. A target that cannot be parsed, or that Spark cut short, is `null` with the raw string kept, never a partial path; a write-like node outside the known list is reported as unrecognized. `executionsWithoutPlan` lists SQL executions the report cannot see, with a reason (no plan recorded, or an unreadable start event), and `skippedLines` counts the log lines that could not be read. Writes made outside SQL do not appear in the event log and are not covered.
