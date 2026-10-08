# CI and automation

How to run SparkForensics from a pipeline or script with the `analyze` CLI: its output formats, the extra data in the JSON report, and gating on several budgets and candidates.

In a pipeline or a script, use the `analyze` CLI instead of the browser
dashboard. It parses the same event logs and exits non-zero when a run
crosses a threshold you set, so it can gate a build:

```sh
npx -p sparkforensics-cli sparkforensics-analyze <file|dir> [--max-runtime ms] [--max-skew ratio] \
  [--max-spill gb] [--max-failed-task-rate pct] [--min-efficiency pct] \
  [--out path]
```

Output is JSON by default; `--format md` writes the Markdown report instead.
Budget violations and inconclusive budgets print to stderr as
`[violation] ...` and `[inconclusive] ...` lines. The exit code is 0 when
every budget passes, 1 when one is violated, 3 when none is violated but one
is inconclusive, 2 for a usage error (bad flags or arguments, an invalid
`--thresholds` or `--budgets` file), 4 when the candidate log can't be read or
parsed or its History Server fetch fails, 5 when the `--baseline` log can't be
read or parsed, and 6 for an internal error, including a failed `--export-html`.
When several of these apply, the worst wins in this order: 6, 5, 4, 1, 3, 0.
A usage error exits 2 before any log is read.

`--min-efficiency` checks busy core time, the share of executor core time that
ran tasks (100 minus the dashboard's Unused core time). It is not the
dashboard's Efficiency tile, which is the share of wall-clock with a stage
running, so the two can differ widely on the same run.

The command ships in the `sparkforensics-cli` package. To install it once:
`npm i -g sparkforensics-cli`, then run `sparkforensics-analyze` directly.
`npx sparkforensics-analyze <file>` is a shorter way to run the same command.

Point it at a single event-log file, or at one run's `eventlog_v2_*`
rolling-log directory; any other directory is rejected. Output goes to
stdout; pass `--out <path>` to write it to that file instead.

Pass `--export-html <dir>` to write a self-contained HTML dashboard for the
run into `<dir>` (which must not already exist or must be empty). Open
`<dir>/index.html` directly in a browser over `file://`, with no server, to
get the same interactive dashboard offline, without the docs links. This
makes it easy to archive or share a run. `--redact` applies to the exported
report too.

## Machine-readable fixes and costs

Each row of the JSON report's `findings` array carries two fields for a script
or tuning loop that acts on the output without reading prose.

`remediation` is an array of the changes the row's `recommendation` names, in
structured form. It is empty when the recommendation names no Spark property
and no change to the job.

```json
"remediation": [
  { "kind": "conf", "key": "spark.sql.shuffle.partitions", "direction": "increase", "suggested": 800 }
]
```

- `kind` is `"conf"` (a Spark property) or `"code"` (a change to the job's code
  or data). A consumer that reads `key` checks `kind` first.
- `direction` is `"increase"` or `"decrease"` (move the current value that
  way) or `"set"` (take the `suggested` value, for a switch or a class name).
- Entries apply together unless the `recommendation` words them as
  alternatives ("either ... or"). An idle-capacity finding (`utilization`,
  `memoryUtilization` with `variant: "idleCores"`) does this with dynamic
  allocation off or unset: `set spark.dynamicAllocation.enabled` and `decrease
  spark.executor.instances` are alternatives, so apply one. With dynamic
  allocation on, it lowers `spark.dynamicAllocation.maxExecutors`, and also
  `spark.dynamicAllocation.minExecutors` when the run logs a value above 0.
- `suggested` is the value the detector computed, or `null` when it computes
  none. Counts are numbers, switches are booleans, sizes carry a Spark unit
  suffix (`"1024m"`).

A `code` entry has no `key`, `direction` or `suggested`, only a `hint`:

```json
"remediation": [{ "kind": "code", "hint": "salt the key or repartition on a better key" }]
```

Skew findings, and straggler findings whose cause is `data`, carry one when no property can fix them: the
stage's `evidence.origin` is `other`, or AQE skew-join handling is on and its
`evidence.aqeSkew` case calls for a change to the job. The `hint` is the remedy
the `recommendation` gives.

`impactEstimate.coreTimeMs` is the busy core time the fix removes: the
executor task time, in core-milliseconds, next to the `wallClock` range
(elapsed time). It is a `{ "low": ..., "high": ... }` range with `low` equal
to `high`, or `null` when the detector measures no such figure: `null` means
unknown, never zero. Only figures read from the log count: GC time, the
executor time of retried and discarded speculative attempts, and for skew
and straggler findings the task time the fix removes from the slow tasks. These are set even when the log has
no executor core data. A finding with only a wall-clock claim has
`coreTimeMs: null`: its elapsed time is not converted to core time. Task run
time is used, not `executorCpuTime`, so Python worker CPU is not missed.

Findings whose only figure is bytes or memory-time have `coreTimeMs: null`, as
do findings whose core figure rests on an assumed constant: `coreLocality`'s
per-task fetch penalty and the executor-hours or job-hours of
`autoscalingChurn` and `jobFailureRate`. Their `rawWaste` is unchanged.

`coreTimeMs` never includes idle capacity. A finding whose waste is allocated
cores that ran no task (`utilization`, `stageShape`'s low parallelism and
task/stage skew rows) has `coreTimeMs: null` and keeps its figure in
`impactEstimate.rawWaste` with `"idle": true`; every surface labels it "of
idle core capacity", not "of core time". A stage's slow tail is counted once:
when `skew` and `straggler` both flag the same stage, `skew` carries the
removed task time and `straggler` has `null`.

`impactEstimate.idleCoreTimeMs` is the idle capacity as a number a script can
rank by: the `utilization` finding's allocated core time that ran no task, in
core-milliseconds, as a `{ "low": ..., "high": ... }` range with `low` equal to
`high`. It is the run's allocated core-milliseconds (`allocation.coreHours`)
minus the busy core-milliseconds, never below zero and never above the
allocation. It is the same quantity as the finding's `rawWaste`, kept apart from
`coreTimeMs`, which is busy time a fix removes. The field is absent on every
other finding, and on a `utilization` finding the log gives no executor cores to
allocate. The `memoryUtilization` finding with `variant: "idleCores"` is the
memory view of the same condition and carries no `idleCoreTimeMs`.

A finding on a serial basis whose figure is modeled has no core time either.
`partitionSizing`'s `lowShuffleParallelism` reports `rawWaste` in `ms`: stage
wall-clock that more partitions shorten, not task work they remove. It has
`coreTimeMs: null` and is ranked on `wallClock`, which models the stage with its
longest task split evenly across the partition count the stage needs.

When the effective `spark.sql.shuffle.partitions` (logged, else Spark's 200) is
already at or above the count a low-parallelism shuffle stage needs, the
property is not what limits that stage: the recommendation points at the
stage's own partitioning (`repartition(n)` or RDD parallelism) and
`remediation` is empty. When AQE coalescing is on and a stage in a SQL execution
ran fewer tasks than the property (or than
`spark.sql.adaptive.coalescePartitions.initialPartitionNum`, which replaces it
as the starting count when set), AQE merged the partitions and the
recommendation points at `spark.sql.adaptive.advisoryPartitionSizeInBytes`
instead. A stage outside any SQL execution is never read as coalesced. `shuffle` and
`partitionSizing` (`lowShuffleParallelism`) findings carry `evidence.partitions`
(`raise`, `sufficient`, `aqeCoalesced` or `ownPartitioning`) for the case.

A `remediation` that sets a property to a fixed value (for example
`spark.sql.adaptive.skewJoin.enabled`, `spark.speculation` or
`spark.dynamicAllocation.enabled`) is left out when the run's effective conf
already has that value. The effective value is, in order, the setting the SQL
execution ran with (its `modifiedConfigs`, for a finding scoped to one
execution), the logged property, and Spark's default for the run's
`sparkVersion`. A job that calls `spark.conf.set` is judged against what it set.
The defaults come from Spark's own configuration sources and cover every
property a detector reads or suggests: AQE (`spark.sql.adaptive.enabled` is off
before Spark 3.2 and on from 3.2; skew-join and coalescing from 3.0, and the
advisory partition size and `coalescePartitions.parallelismFirst`, on from 3.2),
`spark.sql.shuffle.partitions` (200),
`spark.sql.autoBroadcastJoinThreshold` (10 MB), speculation (the multiplier is
1.5 and the quantile 0.75 before Spark 4.0, 3 and 0.9 from 4.0) and the
dynamic-allocation, serializer and event-log switches, and the executor memory
overhead factor (from 3.3) and minimum (from 4.0). A default that depends on the cluster (`spark.executor.instances`,
`spark.default.parallelism`) is not modeled. Spark before 3.0 has no AQE
skew-join handling, so a skew finding on such a run suggests no conf. Booleans compare
case-insensitively. The recommendation then stops naming that property and
points at the remedy left (for example "AQE skew-join handling is already on,
so salt the key or repartition on a better key"), so the text and
`remediation` never disagree. The dashboard's one-line fix for a group of such
findings follows the same effective conf.

Two effective settings change which fix is offered. Skew-join handling counts as
already on only when `spark.sql.adaptive.enabled` is not effectively `false`;
with AQE off (logged, or the default on Spark 3.0 and 3.1), the skew findings
suggest setting `spark.sql.adaptive.enabled` to `true` instead. When
`spark.sql.autoBroadcastJoinThreshold` is logged `-1` (auto-broadcast
disabled), and under adaptive execution
`spark.sql.adaptive.autoBroadcastJoinThreshold` is unset or `-1` too, an
over-broadcast finding has an empty `remediation` and points at removing the
`broadcast()` hint.

Skew-join handling is only suggested for a stage that reads a shuffle in a SQL
execution whose plan has a sort-merge or shuffled-hash join. Skew findings
carry `evidence.origin`: `shuffleJoin` (the conf above applies), `inputScan`
(a stage reading uneven input files: the remediation lowers
`spark.sql.files.maxPartitionBytes`) or `other` (no conf is suggested; the `remediation` holds a `code` entry).
A `shuffleJoin` finding on a run with AQE skew-join handling on also carries
`evidence.aqeSkew`, the reason handling did or did not act on the stage's join:
`split`, `evenReads`, `belowThreshold`, `planShape`, `userRepartition`, `joinType`,
`extraShuffle` or `notSplit` (see `SKEW`). The remediation matches the case: a
`decrease` of the skew threshold or factor for `belowThreshold`, a `set` of
`spark.sql.adaptive.forceOptimizeSkewedJoin` for `extraShuffle` from Spark 3.3
(or on a run with no recorded version that logs the property), next to the `code`
entry when a one-sided `joinType` is also blocked by an extra shuffle, none for
`split` and `evenReads`, and a `code` entry otherwise.
`shufflePartitionSkew` carries the same fields but is judged on shuffle-read
sizes, so it is only ever `shuffleJoin` or `other`. A `stageSlowness` finding carries `evidence.reads` (`shuffle`,
`input` or `other`) and suggests partition-count changes only for `shuffle`; `spill`
and `tinyTask` carry the same `reads` key and gate their partition-count
advice the same way. On a `shuffle` stage the remediation names the lever that
sized it: `spark.sql.shuffle.partitions`, AQE's advisory size or
`parallelismFirst` where AQE coalesced the stage (`parallelismFirst=false` comes
first while it is on, the advisory size after it), or a `code` entry where the
stage's own `repartition(n)` or RDD parallelism did. `straggler` carries `evidence.origin` and the same skew
advice as a skew finding on that stage when its `evidence.cause` is `data`; `unattributed` gets no fix, and other causes get advice for that cause. `coldStart` and `autoscalingChurn`
carry `evidence.dynamicAllocation` (`on` or `off`) and suggest no
dynamic-allocation property when it is `off`. `underBroadcast` and
`overBroadcast` carry `evidence.broadcastThreshold` (`limits`, `notLimiting` or
`disabled`) and suggest changing the threshold only when it limits the join.

The CLI also supports fetching a run directly from a reachable Spark History
Server (`--shs-base-url`/`--app-id`/`--attempt-id`) instead of a local file,
comparing a candidate run against a baseline with regression gating
(`--baseline`/`--max-regression-pct`/`--regression-metric`/
`--fail-on-introduced`; the baseline is a local file or rolling-log
directory, no History Server), several regression budgets and several
candidates in one call (`--regression-budget`/`--budgets`, see
[Several budgets and several candidates](#several-budgets-and-several-candidates)),
rewriting run-specific text before stages are paired (`--normalize-path`, see
[Pairing stages across runs](#pairing-stages-across-runs)), redacting the app id, the app name and any host/IP
tokens before sharing output (`--redact`), and narrowing the findings to certain impact
bands, types, or a stage (`--impact`/`--type`/`--stage`), and tuning
detector thresholds from a file (`--thresholds`, below). Run it with
`--help` for the full flag list.

Same caveat as above: if the History Server is only reachable through an SSH
bastion, `--shs-base-url` can't reach it either: see
[Behind an SSH bastion](../alternative-log-retrieval/ssh-bastion.md#behind-an-ssh-bastion).

Running in Airflow instead of a plain CI pipeline? See
[sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator),
an Airflow operator that wraps the CLI and acts on the result after each
Spark job, so you don't have to wire up the call yourself.

Want an AI assistant to diagnose a run directly, without the dashboard or a
CI gate? See [MCP tools reference](../mcp-tools.md).

## Write targets {#write-targets}

The JSON report has a top-level `writeTargets` object listing every SQL write
in the run, so a script can check where a job wrote without reading the plan.
It has no Markdown counterpart. The MCP `diagnose_run` tool returns it too.

```json
{
  "writes": [
    {
      "sqlExecutionId": 3,
      "nodeId": "e3:n0",
      "command": "InsertIntoHadoopFsRelationCommand",
      "recognized": true,
      "kind": "path",
      "target": "hdfs://nn/sandbox/out/t1",
      "outputRows": 5000000,
      "mergeRows": null,
      "raw": "Execute InsertIntoHadoopFsRelationCommand hdfs://nn/sandbox/out/t1, false, Parquet, ..."
    }
  ],
  "executionsWithoutPlan": [{ "sqlExecutionId": 4, "reason": "noPlan" }],
  "skippedLines": 0
}
```

- `writes` holds one row per write node, ordered by SQL execution id and then
  by position in the plan. A `DeltaTable` API merge has no write node: it is one
  extra row per merge, see [Delta writes](#delta-writes). `command` is the plan node's name without the
  `Execute ` prefix or an `Exec` suffix, `nodeId` is the plan node's id, and
  `raw` is the node's full plan string as the log recorded it.
- `kind` says how to read `target`:
  - `path` is a filesystem location.
  - `table` is a table name whose catalog the command states or implies: a
    Hive or V1 command's `database.table`, a DataSource V2 name with a
    catalog part (`catalog.namespace.table`), or a Delta command's table as
    `database.table` (a table in the session catalog) or
    `catalog.database.table`.
  - `unqualifiedTable` is a DataSource V2 name with no catalog part, such as
    `default.events` or `events`. The log does not say which catalog it lives
    in, so a check on its database part alone can match the wrong catalog.
  - `jdbcTable` is a `dbtable` of a JDBC write. It names a table in an external
    database, not in a Spark catalog, and the database itself (the JDBC url) is
    not reported.

  Every target is copied verbatim from the plan string: nothing is resolved, so
  a relative path, an unexpanded `${var}` placeholder or a bare table name
  appears exactly as the log states it. Backticks around table name parts are
  dropped.
- `target` and `kind` are `null` when the target cannot be determined. That
  covers a node whose plan string has no target (Spark omits it for some
  commands, and Delta command nodes carry none on real logs, which
  [Delta writes](#delta-writes) covers), a redacted option value, a plan string
  that names more than one candidate target, and a plan string Spark cut short. A target is reported only when its whole text is followed by
  a delimiter in the plan string: a path cut by
  `spark.sql.maxMetadataStringLength` or a name with a `...` marker in it is
  `null`, never a partial path. A trailing `... N more fields` after the
  target, such as the column list of `InsertIntoHadoopFsRelationCommand`, does
  not affect the target before it. Treat a `null` target as unknown, not as
  inside or outside any location.
- `outputRows` is the node's own `number of output rows` SQL metric. It is
  `null` when the log has no such metric for that node, which is the case for
  the DataSource V2 and Delta write nodes that report other metrics.
- `mergeRows` holds the row counts of a Delta MERGE: `inserted`, `updated`,
  `deleted` and `copied`, read from the `MergeIntoCommand` node's SQL metrics
  (`number of inserted rows`, `number of updated rows`, `number of deleted rows`
  and `number of target rows rewritten unmodified`; older Delta releases name
  the last one `number of rows copied`). It is `null` for every other command,
  for a MERGE node that reports none of the four, and for a `DeltaMerge` row
  (see [Delta writes](#delta-writes)). To check that two runs merged the same
  rows, compare `inserted + updated + deleted`. `copied` counts target rows
  Delta rewrote unchanged, which depends on how the table's files are laid out.
- `recognized` is `true` for the commands below and `false` for a write-like
  node that is not in that list. An unrecognized write always has `target` and
  `kind` `null`, and `raw` is the only information about it.
- `executionsWithoutPlan` lists the SQL executions whose writes the report
  cannot see, each with a `reason`. `noPlan` means the execution started but the
  log has no plan for it, such as an execution still running when the log was
  cut off (a plan is read when its execution ends). `unreadableStart` means the
  execution's start event was skipped because it could not be read, for example
  a plan nested deeper than 500 nodes or a start line cut off at the end of the
  log. A write in one of these executions is not in `writes`, so a non-empty
  list means the report may be incomplete.
- `skippedLines` is the number of log lines the parser could not read. A line
  cut off before its execution id is not in `executionsWithoutPlan`, so a
  non-zero count means a write may be missing even when that list is empty. It
  is `null` when the count is unknown.

Recognized commands and where their target comes from:

| Command | Target |
| --- | --- |
| `InsertIntoHadoopFsRelationCommand` | `path`: the first argument, including for an `INSERT OVERWRITE ... PARTITION` that prints a static-partition map after it |
| `InsertIntoHiveTable`, `CreateDataSourceTableAsSelectCommand`, `CreateHiveTableAsSelectCommand`, `OptimizedCreateHiveTableAsSelectCommand` | `table`: the first argument |
| `SaveIntoDataSourceCommand` | `path` from the `path` option, or `jdbcTable` from the JDBC `dbtable`/`table` option |
| `AppendData`, `OverwriteByExpression`, `OverwritePartitionsDynamic`, `ReplaceData`, `WriteDelta`, `WriteToDataSourceV2`, `AppendDataExecV1`, `OverwriteByExpressionExecV1` | `table` or `unqualifiedTable`: the `table=` of the connector's write object, for example Iceberg's `IcebergWrite(table=..., ...)`. For a Delta table, see [Delta writes](#delta-writes) |
| `CreateTableAsSelect`, `AtomicCreateTableAsSelect`, `ReplaceTableAsSelect`, `AtomicReplaceTableAsSelect` | `table` or `unqualifiedTable`: the identifier after the catalog object, which does not name the catalog |
| `WriteIntoDelta`, `WriteIntoDeltaCommand`, `UpdateCommand`, `DeleteCommand`, `MergeIntoCommand` | `path`: the first argument when it is a `delta.` path table (never for `MergeIntoCommand`, whose plan string also prints the source); otherwise as in [Delta writes](#delta-writes) |
| `CreateDeltaTableCommand`, `OptimizeTableCommand`, `RestoreTableCommand`, `DeltaReorgTableCommand` | `path`: the first argument when it is a `delta.` path table, otherwise `null` |
| `DeltaMerge` | not a plan node: one row per `DeltaTable` API merge, see [Delta writes](#delta-writes) |

A plan node not in the table is a write when its operator name (the first word
of the node name after any leading `Execute`, so not the relation or table a
scan prints after it), split
into CamelCase words, contains `Write`, `Insert`, `Save`, `Overwrite`, `Append`, `Merge`,
`Update`, `Delete`, `Truncate`, `Replace`, `Drop`, `Load`, `Vacuum`,
`Convert`, `Clone`, `Restore`, `Optimize`, `Alter`, `Reorg`, `Rename` or
`Call`, or contains `TableAsSelect`, `AddPartition`, `DropPartition`,
`RenamePartition` or `RecoverPartitions`. That covers table DDL and
`ADD PARTITION ... LOCATION`, and an Iceberg procedure call (`Call`), whose
target is a procedure argument and not a path, so it is reported with a `null`
target. A name containing `Join` (`SortMergeJoin`) and these operators that
share a word with a write but write nothing are not: `WriteFiles` (the child of
a write command), `AppendColumns`, `AppendColumnsWithObject`, `MergeRows`,
`StateStoreSave`, `StateStoreRestore`, `SessionWindowStateStoreSave`,
`SessionWindowStateStoreRestore` and `UpdateEventTimeWatermarkColumn`. The
classification leans toward reporting too much: a node that matches by name is
listed with a `null` target rather than dropped.

### Delta writes {#delta-writes}

On a real log a Delta command node (`MergeIntoCommand`, `UpdateCommand`,
`DeleteCommand`, `WriteIntoDelta`, `SaveIntoDataSourceCommand`) is a bare name:
its plan string has no target. The target is read from up to two other places,
in this order, and is `null` when neither names exactly one target.

1. The command's `Arguments:` line in Spark's physical plan description. The
   parser drops the rest of that text to save memory, but keeps this one line
   for these commands. A quoted table name that appears once on the line is the
   target, as `kind: "table"` (`spark_catalog` is dropped, so it reads
   `database.table`). A `SaveIntoDataSourceCommand` is read this way only when
   the line shows a Delta source, and its target is the `path` option. A
   description that spans two read chunks is not kept for a
   `SaveIntoDataSourceCommand`, which prints its whole query plan under it; its
   target is then `null`.
2. For `MergeIntoCommand`, `UpdateCommand` and `DeleteCommand` only, the
   `_delta_log` path in the plans of the executions that share the command's
   root execution, as `kind: "path"`. Exactly one distinct path must appear. It
   applies only when the command is its own root execution, and a source that is
   itself a Delta table adds a second path and leaves the target `null`. The
   write commands (`WriteIntoDelta`, `WriteIntoDeltaCommand`,
   `SaveIntoDataSourceCommand`) never take this step, because a write may read
   another Delta table as its source: with no table or `path` option on the
   arguments line, their target is `null`.

An append or overwrite of an existing Delta table (`saveAsTable` in `append` or
`overwrite` mode on an existing table, `INSERT INTO`, `INSERT OVERWRITE`) prints
the table object as its first argument, and that names the table: `kind:
"table"` as `database.table` (`catalog.database.table` outside the session
catalog), or `kind: "path"` for a path-based table. A `CREATE TABLE ... AS
SELECT`, `CREATE OR REPLACE TABLE` or `saveAsTable` that creates or replaces a
table runs two executions under one root: the create or replace node, which
names the table as `unqualifiedTable` because Delta's catalog object does not
state its catalog name, and an `AppendDataExecV1` whose staged table has no name.
That append takes the table its root's create or replace node names, and is
`null` when the root has no single such node.

A merge made with `DeltaTable.merge(...).execute()` normally runs a
`MergeIntoCommand` too (its description is `toDataset$ at DeltaMergeBuilder`),
and is reported like a SQL MERGE, including two merges run from threads of one
session, whose sub-queries are told apart by their root execution. Some logs
have no such command execution for an API merge. Its queries are then separate
root executions, and the only things tying them together
are a `MERGE operation` description and adjacent execution ids. Each run of
consecutive ids with such a description is reported as one write with the
synthetic command `DeltaMerge`, `kind: "path"` and the table path from the
`_delta_log` of the plans in the run. The log holds no table name for these
merges. The run must hold a write phase (a description containing `writing` or
`rewriting`), because a run that only scanned may have read the merge's source.
The target is `null` when the run has no write phase, names zero or several
paths, has a plan or start time missing, or has start times that overlap another
run's (merges on concurrent threads); `raw` says which. Two merges whose
executions have consecutive ids are one run and name two paths, so they get no
target. A description a user sets that starts with `MERGE operation` is
indistinguishable from Delta's and is reported the same way. `raw` reads
`Delta MERGE operation, executions 10-17`.

Only SQL writes are covered. Writes made outside Spark SQL, such as an RDD
`saveAsTextFile` or a direct filesystem call from the driver, do not appear in
the event log and are not in `writeTargets`.

## Generator

The CLI's JSON output carries a `generator` block naming the build that wrote
it: `name` and `version` of the CLI package, and `buildId`, the build id of the
analysis core the CLI loaded. Equal build ids mean equal analysis code. With
`--baseline` the block is inside `candidate`. The MCP `diagnose_run` tool does
not return it. The block holds no run identifiers, so `--redact` leaves it as is.

```json
"generator": { "name": "sparkforensics-cli", "version": "0.7.0", "buildId": "9c1f3a7e2b4d" }
```

## Metrics block

The CLI's JSON output carries a `metrics` block next to the report, for
scripts that act on a run without reading the report. With `--baseline` it is
inside `candidate`. The MCP `diagnose_run` tool returns the same block. It has its own `schemaVersion`, separate from the
report's. A figure the log cannot provide is `null`, never `0`: a log from a
Spark version that records no CPU time has `executorCpuTimeMs: null`, and a
log cut off before any executor joined has null allocation. The time, data
and task figures, run-level and per row, include the work of every attempt of
a resubmitted stage, failed attempts too, and the tasks of a failed attempt
that end after it (killed or still running when it failed); skew describes
the latest attempt.

| Field | Meaning |
| --- | --- |
| `runComplete` | `true` when the log has an application-end record. `false` means the log was cut off and every total covers only what it recorded. |
| `time.wallClockMs` | Application start to end; null without both. |
| `time.executorCpuTimeMs` | Summed CPU time of every task attempt, including failed attempts, retries and speculative copies that lost. Null when no task recorded any. Misses Python worker CPU, see `python`. |
| `time.executorRunTimeMs`, `time.gcTimeMs` | Summed run time and JVM GC time of every task attempt, counted like the CPU time. |
| `data.memorySpillBytes`, `data.diskSpillBytes` | Summed spill. |
| `data.shuffleReadBytes`, `data.shuffleWriteBytes` | Summed shuffle bytes, local plus remote on the read side. |
| `data.inputBytes`, `data.outputBytes`, `data.outputRows` | Summed input, output and rows written. `outputRows` is null when no task reported rows. |
| `data.peakExecutionMemoryBytes` | The largest per-task peak execution memory. Null when every task reports 0. |
| `shape.taskCount`, `shape.stageCount` | Distinct task records and stages. |
| `shape.failedStageAttempts` | Stage attempts that ended with a failure reason, including an attempt Spark then resubmitted (a fetch failure, for example). |
| `shape.retriedStages` | Stages submitted more than once. |
| `shape.failedTasks`, `shape.retriedTasks` | Task-level counts: tasks whose final attempt failed, and task attempts superseded by a retry. |
| `shape.maxSkew` | The largest stage skew ratio, the figure `--max-skew` checks (P95 over median, or max over median for a stage with few tasks; `skew.minTasksForP95` from `--thresholds` applies). |
| `allocation.coreHours`, `allocation.memoryGbHours` | See [Allocation](#allocation). |
| `allocation.dynamicAllocation`, `allocation.executorsPeak`, `allocation.executorsMean`, `allocation.executorCores`, `allocation.executorSeconds` | The executor allocation behind the hours, see [Allocation](#allocation). |
| `python.shareOfTaskRunTime` | See [Python share](#python-share). |
| `stages` | The per-stage rows. |

`stages` holds one row per stage fingerprint, keyed by the same fingerprint
the run comparison matches stages on (the normalized stage name plus the
stage's plan nodes), so the same stage has the same key in a baseline and a
candidate run. A stage repeated in a loop shares one key: its row sums the
repeats and lists them in `stageIds`. A row carries `durationMs`,
`executorCpuTimeMs`, `executorRunTimeMs`, `gcTimeMs`, the spill, shuffle,
input and output figures, `outputRows`, `peakExecutionMemoryBytes`,
`taskCount`, `failedTasks`, `retriedTasks` and `skew` (the largest skew ratio
among the repeats) as above, plus `failed` (an attempt of the stage failed),
`retried` (the stage was submitted more than once) and `python` flags. The
stage-attempt figures, run-level and per row, are null for a stage record
that carries no attempt count. With `--redact` the `metrics` and
`effectiveConf` blocks are built from the redacted run the report uses, so
they carry the same `host-N` and `app-N` pseudonyms: the keys come from
redacted stage names.

### Allocation

`allocation.coreHours` is the sum over executors of cores times hours alive.
`allocation.memoryGbHours` is the sum of memory times hours alive, in GiB
(1024 MiB). An executor is alive from its executor-added event to its first
later executor-removed event. One with no removal event closes at the
application end when the log has one. In a cut-off log (`runComplete` false)
it closes at the last timestamp the log records (the latest application,
stage or executor event), so the figure is a lower bound.

Cores per executor are the executor-added event's total cores. Under dynamic
allocation or YARN defaults, where `spark.executor.cores` is not set, that is
the core count the cluster manager actually granted; when the event carries
none, `spark.executor.cores` is used. If neither exists the core-hours are
null.

Memory per executor is the container size Spark requests: `spark.executor.memory`
(1g when unset), plus the overhead, plus `spark.memory.offHeap.size` when
`spark.memory.offHeap.enabled` is `true`, plus `spark.executor.pyspark.memory`.
The overhead is `spark.executor.memoryOverhead`, else the legacy
`spark.yarn.executor.memoryOverhead`, else the larger of 384 MiB and
`spark.executor.memoryOverheadFactor` (default 0.1) times the executor
memory. Memory GB-hours are null when the log records no Spark properties at
all, or a memory property cannot be read. Driver resources are not included.

The same alive intervals give the executor figures, each null when the log has
no executor-added event:

- `allocation.executorSeconds` is the sum of seconds alive over executors.
- `allocation.executorsPeak` is the largest number of executors alive at once.
- `allocation.executorsMean` is `executorSeconds` divided by the seconds from
  application start to close (the end, or the last recorded timestamp in a
  cut-off log), so the mean times the run's wall clock is `executorSeconds`. It
  is null when the log has no application start.
- `allocation.executorCores` is the cores per executor when every executor has
  the same count, null when a count is unknown or they differ.

`allocation.dynamicAllocation` is `on` or `off` when the log records
`spark.dynamicAllocation.enabled`, and `null` when it does not. Spark's default
is off, but a key the log never recorded is not reported as off. It is read
whether or not the log has executor events. The `coldStart` and
`autoscalingChurn` findings' `evidence.dynamicAllocation` reports `on` for any
run not logged as off.

### Python share

`python.shareOfTaskRunTime` is the summed task run time of Python stages
divided by the summed task run time of all stages; null when no task run time
was recorded. It is `0` for a run with task time and no Python stage. Executor
CPU time counts only the JVM task thread, so on a run with a high share it
misses the CPU of the Python worker processes; treat `executorCpuTimeMs` as
unreliable there.

A stage is a Python stage when either signal holds:

- a plan node attributed to it is a Python operator (`PythonRDD`,
  `BatchEvalPython`, `ArrowEvalPython`, `PythonMapInArrow`, or a pandas/Arrow
  grouped or map operator such as `FlatMapGroupsInPandas`, including suffixed
  variants such as `BatchEvalPythonUDTF` and `FlatMapGroupsInPandasWithState`
  and the Spark 4.1 `ArrowAggregatePython` and `ArrowWindowPython`),
  which catches Python UDFs and UDTFs inside SQL;
- its name or call site names `PythonRDD` or `org.apache.spark.api.python`,
  which catches RDD lambdas that have no plan and stages that cannot be
  matched to one.

The "tasks mostly idle" check that keeps a low-CPU stage from being treated
as waiting on an external system uses the same test.

### Other surfaces

Every figure the metrics block shares with another surface reads the same core
code as that surface. The run comparison (the dashboard's comparison view, the
CLI's `--baseline` and the MCP `compare_runs` tool) uses the same sums for run
time, CPU time, GC time, spill, input, output and task count, so a comparison
metric equals the matching `metrics` field for the same run, including the
work of failed and speculative task attempts. Per-stage views in the dashboard
(the stage table and stage detail) describe the stage's latest attempt and the
task attempts that won, so a stage's own figures can be smaller than its row in
`metrics.stages`. The dashboard's Unused core time, the `utilization` finding's percentage and its
idle figure all measure against available capacity, which is
`allocation.coreHours` (cores times the hours each executor was alive), so under
dynamic allocation a run is never idle for cores it did not hold. The
utilization finding's `cpuUtilizationPct` is a share of that capacity, and is
null, as `time.executorCpuTimeMs` is, when the log recorded no CPU time.

## Effective conf

The JSON output also carries `effectiveConf` (with its own `schemaVersion`),
the Spark properties the run
started with, so a script can check that a `--conf` overlay took effect. It is
null when the log records no Spark properties. With `--baseline` it is inside
`candidate`. The MCP `diagnose_run` tool returns the same block.

- `values`: property to value, for every property that is not withheld.
- `maskedKeys`: properties present in the log whose value is withheld.
- `absentKeys`: with `--conf-keys`, the requested properties the log does not
  contain.

A value is withheld when its key or value matches Spark's default secret
pattern (`(?i)secret|password|token|access[.]?key`), as Spark's own redaction
does, when its key names another credential form (`passwd`, `pwd`, `pass`,
`apiKey`, `accountKey` as in `fs.azure.account.key.*`, `privateKey`, `sas`,
`sig`, `credential`), when the key or value matches the job's own `spark.redaction.regex` (when the log records one; if that pattern
uses syntax JavaScript cannot evaluate, every value is withheld), or when the
key or value matches `--conf-redact-regex <pattern>`. A withheld property
shows that it is present, not what it is set to, so the output cannot tell you
whether a masked property has the value you expected. No hash or other
derivative of a withheld value is emitted.

In every other value, credentials are replaced with `[redacted]`: in a value
that looks like a URL, `user:password@host` userinfo and the Oracle thin
`user/password@host` form; in any value, `name=value` parameters named
`password`, `passwd`, `pwd`, `pass`, `apikey`, `accountkey`, `sas`, `sig`,
`signature` and similar (JDBC and ODBC strings, query strings, JVM options),
including signature parameters such as Azure SAS `sig=` and
`X-Amz-Signature=`.
`--conf-keys a,b` narrows `values` and `maskedKeys` to the named properties.

With `--redact`, the host names the report pseudonymizes become `host-N` in
every value: the values of `*.host` and `*.hostname` properties, executor
hosts, and IP or EC2-style addresses. `spark.app.name` becomes the
application's `app-N` pseudonym. A host name that appears only in some other
property, such as `spark.yarn.historyServer.address`, is left as is; withhold
it with `--conf-redact-regex` or leave it out with `--conf-keys`.

## Pairing stages across runs {#pairing-stages-across-runs}

With `--baseline`, the `comparison` object pairs the stages of the two runs
(`stagePairs`, with each pair's `deltas`) and reports `runtimeCoverage`, the
share of both runs' executor run time that sits in paired or replanned stages.
`confidence` is `ok`, `low` or `insufficient`: `low` when the application names differ or
`runtimeCoverage` is under 0.9, `insufficient` when neither run recorded any
executor run time. `confidence` does not change an exit code. The fields and
the matching rules are in [`compare_runs`](../mcp-tools/compare-runs.md) and
[How stages are matched](../run-comparison/how-stages-are-matched.md).

When a stage writes to a path that differs per run, for example
`{sandbox_root}/{session}/{variant}/{batch}` where the variant is `baseline` in
one run and `c07b` in the other, the write stage cannot pair, and it is often
the heaviest. Pass `--normalize-path <regex>`, repeatable, to rewrite what the
patterns match, in every plan node's text, before stages are paired:

```bash
sparkforensics-analyze candidate --baseline baseline \
  --normalize-path '/sandbox/[^/]+/[^/]+/' --format json
```

Every match is replaced with a fixed token. Despite the name it is a generic
regular expression, not only for paths. It needs `--baseline` and applies to
every candidate of a several-candidates run. It changes which stages pair, and
so `stagePairs`, `runtimeCoverage` and `confidence`; findings and the other
metrics are untouched. At most 16 patterns of 200 characters each. An invalid
pattern, or one that matches the empty string, exits `2` before any log is
read.

## Several budgets and several candidates

### Several regression budgets

`--max-regression-pct` checks one metric. To gate on several in one call,
repeat `--regression-budget <metric>:<pct>`, or list them in a file passed
with `--budgets <file>`. Both need `--baseline`, and each budget takes a
[metric key](./regression-metric-keys.md#regression-metric-keys) and a percentage of zero or more:

```bash
sparkforensics-analyze candidate --baseline baseline \
  --regression-budget wallClock:10 --regression-budget gcTime:25
```

The `--budgets` file is JSON with one key, `regression`, mapping a metric key
to its percentage:

```json
{ "regression": { "wallClock": 10, "gcTime": 25, "failedTaskRate": 0 } }
```

The CLI refuses to run, with exit code 2 and a message naming the problem,
for an unknown top-level key, an unknown metric key, a percentage that is not
a non-negative number (in the file a JSON number, not a string; on the flag
plain digits such as `10` or `2.5`), or a file that can't be read or isn't
valid JSON.

The budgets combine like this:

- `--max-regression-pct` with `--regression-metric` (default `wallClock`)
  still works and counts as one more budget next to the new ones.
- Each metric can be budgeted once across the legacy pair, the repeated flag
  and the file. A metric named twice is a usage error (exit 2), even when both
  give the same percentage.
- Each budget is checked on its own and gives one `max-regression` result
  that carries `metric`, the key it checks. Any violated budget makes the run
  exit `1`; otherwise an inconclusive one makes it exit `3`. A budget on a
  metric the baseline or the candidate log can't provide is inconclusive,
  never a pass.

### Per-stage regression budgets

`--max-regression-pct` and `--regression-budget` judge a whole-run metric. To
gate on the stages themselves, repeat
`--stage-regression-budget <metric>:<pct>` (with `--baseline`). The budget
fails when any paired stage's metric grew by more than the percentage against
its baseline stage. The metric is one of `executorRunTime`, `executorCpuTime`, `memoryBytesSpilled`,
`diskBytesSpilled`, `shuffleReadBytes` and `shuffleWriteBytes`:

```sh
sparkforensics-analyze candidate.zstd --baseline baseline.zstd \
  --stage-regression-budget executorRunTime:25 --stage-regression-budget diskBytesSpilled:0
```

- The stages come from the comparison's `stagePairs`. By default only `exact`
  and `structural` pairs count, since an `aligned` pair may compare different
  work. `--stage-quality exact,structural,aligned` chooses the qualities; each
  pair's `quality` and `score` are in the comparison output. Stages a re-plan
  left over are not paired and are not checked.
- Each metric gives one `max-stage-regression` result carrying `metric`, whose
  detail names the worst offenders by `pairId`. A violation exits `1`.
- A stage that grew from a zero baseline exceeds any percentage.
- It is inconclusive (exit `3`) when no eligible stage pairs or the metric is
  missing on every one, never a pass. A comparison with `low` or
  `insufficient` confidence is still judged on the pairs it has.
- A metric can be budgeted once. `--stage-quality` without
  `--stage-regression-budget`, an unknown metric or quality, and a metric
  named twice are usage errors (exit `2`), and so are `inputBytes` and
  `outputBytes`: workload volume has no regression direction.

### Several candidates

Pass two or more logs as positional arguments, with `--baseline`, to compare
each against the same baseline. The baseline is parsed once. Output is
NDJSON: one line per candidate, in argument order, written as each one
finishes. `--out <path>` writes the lines to a file instead of stdout, and
`--format ndjson` selects this output for a single candidate too. The mode
can't be combined with `--export-html`, `--shs-base-url`, `--format json` or
`--format md` (exit 2). `--redact`, `--thresholds`, `--impact`, `--type`,
`--stage`, `--conf-keys`, `--conf-redact-regex` and every budget flag apply
to each candidate.

Each line is one JSON object:

| Field | Meaning |
| --- | --- |
| `log` | The candidate path, as given on the command line. With `--redact`, `candidate-<n>` instead, `n` being the candidate's 1-based position. |
| `status` | `pass`, `violation`, `inconclusive` or `error`. |
| `exitCode` | The exit code this line alone would give: `0` for `pass`, `1` for `violation`, `3` for `inconclusive`, and for `error` `4` (the log can't be read or parsed) or `6` (an internal failure while analyzing it). |
| `error` | The message when `status` is `error`; otherwise `null`. With `--redact`, a generic message that names no path. |
| `budgets` | This candidate's budget results, each with `name`, `status` (`pass`, `violation` or `inconclusive`) and `detail`, plus `metric` on `max-regression` and `max-stage-regression`. Empty for an `error` line. |
| `candidate` | The candidate's report with its `metrics` and `effectiveConf` blocks, the same object the single-candidate JSON output carries under `candidate`. `null` for an `error` line. |
| `comparison` | `verdict`, `confidence`, `reason`, `matchedCoverage`, `runtimeCoverage`, `metrics`, `findings`, `comparisonSchemaVersion`, `stagePairs`, `unmatched`, `replanned`, `bookkeepingStageIds` and `executionAlignment`, the same object the single-candidate JSON output carries under `comparison`. `null` for an `error` line. |

A line's `status` follows the single-candidate rules: `violation` if any
budget result is a violation, else `inconclusive` if any is inconclusive
(including the `run-complete` check for a log with no `ApplicationEnd`),
else `pass`.

A candidate that can't be read or parsed doesn't stop the others. Its line
has `status: "error"`, `exitCode: 4`, the message in `error`, and `null` for
`candidate` and `comparison`, as a single-candidate run exits `4` for a
candidate it can't parse. The process exit code is the worst line, in the
order `6`, `5`, `4`, `1`, `3`, `0`, so an unreadable candidate outranks a
violation and a violation outranks an inconclusive result.

Two failures stop the batch before any line is written:

- A usage error (bad flags or arguments, an invalid `--thresholds` or
  `--budgets` file) exits `2`.
- A baseline that can't be read or parsed exits `5`. Fix the baseline and run
  the batch again.

An internal failure that isn't tied to one candidate, such as an unwritable
`--out` path, exits `6`.

With `--redact`, no candidate path is written anywhere, since event-log file
names usually carry the app id. `log` and the `stderr` line prefixes name each
candidate by its 1-based position (`candidate-1`, `candidate-2`, ...), and an
`error` line carries a generic message instead of the parser's, which may
quote the path: `Candidate 2 could not be read or parsed.`, or `could not be
analyzed` for an internal failure. An unreadable baseline prints `The baseline
could not be read or parsed.` to `stderr`. A single-candidate run does the
same, naming `The baseline` or `The candidate`.
