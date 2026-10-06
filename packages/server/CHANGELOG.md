# sparkforensics-server

## 0.6.0

### Minor Changes

- 3f1e7bd: Idle-capacity figures and the low-parallelism partition estimate change values, and the report gains one field. The report's schema version is unchanged. Existing numbers move, so a saved baseline, a budget or a ranking built on them needs refreshing.
  
  - Idle capacity is measured against the run's allocation, the cores times the time each executor was alive that `metrics.allocation.coreHours` reports, instead of peak concurrent cores times the whole run. The peak basis counts cores a dynamic-allocation or late-joining run never held, so the idle figure could exceed the allocation. The `utilization` percentage and its `cpuUtilizationPct`, the `utilization` finding's idle `rawWaste`, `memoryUtilization`'s `idleCores` rate, the dashboard's Unused core time and the verdict's idle share all use it, and the Scorecard's driver and executor split counts the cores held inside and outside the stages' windows from the same executor alive intervals. Utilization rises on runs whose executors came and went, so such a run can clear the 60% utilization threshold or fall under the 50% idle-cores one, and its `utilization` and `idleCores` findings disappear. Across the corpus logs, 26 of these findings disappear (10 `utilization`, 16 `idleCores`) and every remaining `utilization` idle figure is smaller.
  - `impactEstimate.idleCoreTimeMs`, a `{ low, high }` range in core-milliseconds with `low` equal to `high`, gives the `utilization` finding's idle capacity as allocated minus busy core time, never below zero and never above the allocation. It is separate from `coreTimeMs`, which stays null for idle findings because it counts busy task time a fix removes. `idleCores` is the memory view of the same condition and carries none, so consumers rank on one idle figure. The `idleCores` memory figure (`mbSeconds`) is the idle rate times the run's allocated memory-seconds, with Spark's default heap and overhead where the memory properties are not logged. The 12 corpus `idleCores` findings that had no figure now report one, and some memory figures are larger.
  - Idle findings gain remediation. With dynamic allocation off or unset, `set spark.dynamicAllocation.enabled` and `decrease spark.executor.instances` are alternatives, and the recommendation reads "either ... or": apply one. With it on, `decrease spark.dynamicAllocation.maxExecutors`, plus `decrease spark.dynamicAllocation.minExecutors` when the logged floor is above 0, where `remediation` was empty. `remediation` entries apply together unless the recommendation words them as alternatives. The recommendation text names these properties. `spark.dynamicAllocation.executorIdleTimeout` is not suggested, because `autoscalingChurn` recommends raising it.
  - `partitionSizing`'s `lowShuffleParallelism` wall-clock estimate no longer collapses to near zero on a stage whose few long tasks fill its duration. The fix splits those tasks, so the claim is the longest task's own reduction, `taskDurationMax − taskDurationMax × taskCount / targetTaskCount` (the longest task after an even split), instead of scaling the whole stage duration. It is a modeled figure, and `coreTimeMs` stays null: it is stage wall-clock, ranked on `wallClock`. `shufflePartitionSkew` and `maxPartitionTooBig` are unchanged.
- ccfae9e: Four additive changes to the CLI JSON report and MCP `diagnose_run`. The report's `schemaVersion` is unchanged.
  
  - The CLI JSON report carries a `generator` block, `{ name, version, buildId }`, naming the CLI package and the core build that wrote it. MCP `diagnose_run` does not return it, because the MCP server has no real package version to report yet.
  - `metrics.allocation` adds `dynamicAllocation` (`on` or `off` when the log records `spark.dynamicAllocation.enabled`, else `null`), `executorsPeak`, `executorsMean` (executor seconds over application start to close), `executorCores` (`null` when unknown or mixed) and `executorSeconds`. The executor figures are `null` when the log has no executor events. The `coldStart` and `autoscalingChurn` evidence is unchanged.
  - `writeTargets.writes[]` adds `mergeRows`, `{ inserted, updated, deleted, copied }`, read from a `MergeIntoCommand` node's SQL metrics. `outputRows` is unchanged. It is `null` for other commands and for `DeltaMerge` rows, the API merges that run no command node, so those still report no row counts.
  - The `Remediation` union is widened. Besides `{ kind: 'conf', key, direction, suggested }`, an entry can be `{ kind: 'code', hint }`: a fix no Spark property makes. Skew, straggler and partition-skew findings carry one when `evidence.origin` is `other` or AQE skew-join handling is already on, where `remediation` was empty. A consumer that reads `key` on every entry must check `kind` first.

### Patch Changes

- 11e116a: `writeTargets` names the table of a Delta `MERGE`, `UPDATE` or `DELETE` when its plans print the same local table as both `file:/path` and `file:///path`. The two spellings are one path, so the write reports `file:///path` instead of a `null` target.
- b3e3520: The per-finding detection reference files served by the MCP `get_finding_documentation` tool are generated from the user guide at build, test and pack time instead of being committed. Published tarballs contain the same files.

## 0.5.2

### Patch Changes

- e740c9a: Stages now pair in two levels, and the stages a re-plan leaves over are reported as `replanned` instead of `unmatched`.
  
  SQL executions of the two runs align first, in submission order, scored on call site, description and plan structure. Then the stages inside each aligned pair of executions pair as `exact` (same normalized name and plan text), `structural` (same plan shape and sorted attribute names, with literals, paths, file counts and ids left out) or `aligned` (similar text, or no plan to compare and paired by position among stages of one name). A loop that ran 14 times in one run and 15 in the other pairs 14 iterations, a self-join subtree counted 3 times against 2 pairs 2, and a grouping set emitted in another column order each run pairs structurally. The `structural` and `aligned` qualities were reserved values before; `score` is 1 for `exact`, the text similarity for the other two, and 0.5 for a pair made by position.
  
  When an aligned execution pair has different stage counts (a broadcast join took out an exchange) and stages are left over, they are reported once in `replanned`: `baseExecutionId`, `candExecutionId`, `baseStageIds`, `candStageIds` and `deltas` (the total of each delta metric per side). Leftovers under equal stage counts stay `unmatched`.
  
  **Behaviour change: `runtimeCoverage` and `confidence` count replanned run time.** `runtimeCoverage` is the share of both runs' executor run time in paired and replanned stages, so a conf change that re-plans a join can report `ok`. `replanned` carries the totals so a caller can see how much run time that is. Runs whose SQL executions share too little work to be one job (fewer than half of the smaller run's executions pair) get no stage pairs at all, so a comparison of two different jobs reports `low` instead of pairing generic stages such as a lone `count`.
  
  New field `executionAlignment` in the comparison block (`baseExecutions`, `candExecutions`, `pairedExecutions`, `agreement`, `accepted`, `bounded`), in the CLI's `comparison` object, MCP `compare_runs` and the dashboard's result. The execution alignment runs in full up to 1,000,000 execution pairs and in a band around the diagonal above that; `bounded` says which. `comparisonSchemaVersion` stays 1: the change is additive.

## 0.5.1

### Patch Changes

- 64a90a4: Update dependencies to their latest minor and patch releases, including `@modelcontextprotocol/sdk` 1.32, and pick up transitive security fixes from `npm audit fix`.
- ad67597: The CLI and the MCP server now build their run and comparison output from the same core functions, and a contract test diffs the two surfaces on public corpus logs.
  
  Changes to the MCP server's output (intentional, additive):
  
  - `diagnose_run` returns `writeTargets`, `metrics` and `effectiveConf` by default, the same blocks as the CLI's JSON report. Clients that read only the fields it returned before see no difference.
  - `compare_runs` returns `metrics` and `findings`, the names the CLI's `comparison` object uses. `metricDeltas` and `findingsDelta` still carry the same values and are deprecated: they will be removed in the next release.
  - `evaluate_budgets` takes `regressionBudgets`, an array of `{ metric, maxPct }`, matching the CLI's repeated `--regression-budget`. A metric budgeted twice fails the call, as it does on the CLI.
  
  The CLI's JSON, Markdown and NDJSON output, its `[violation] name: detail` stderr line and its exit codes are unchanged.
- 2d2e51b: `writeTargets` now names the target of Delta writes whose plan node carries none, which on real logs is every Delta command node.
  
  - `MergeIntoCommand`, `UpdateCommand`, `DeleteCommand`, `WriteIntoDelta` and a Delta `SaveIntoDataSourceCommand` are resolved from the command's `Arguments:` line (a `table` as `database.table`, or the save's `path`), else (`MergeIntoCommand`, `UpdateCommand` and `DeleteCommand` only) from the single `_delta_log` path of the executions that share its root execution (`path`), else `null`. The parser now keeps that one line of the physical plan description for these commands; every other description is still dropped.
  - A merge made with `DeltaTable.merge(...).execute()` has no command node and used to be missing from `writeTargets`. Each run of its `MERGE operation` executions is now one `DeltaMerge` write with `kind: "path"`. Runs that cannot be told apart from another merge (consecutive ids, overlapping start times, several or no paths) or that have no write phase get a `null` target.
  - `SqlExecutionStart` events now carry `rootExecutionId` into the model.
- 67aecba: Comparisons pair stages with a new aligner and judge confidence by executor run time instead of stage count.
  
  **Behaviour change: a stricter `confidence: "ok"` gate.** `ok` now needs 90% of both runs' executor run time to sit in paired stages (`runtimeCoverage`). Before, it needed 50% of the stages paired by count (`matchedCoverage`), so a pair of runs that passed at 54% stage coverage because its small stages matched, while its heavy stages did not, can now report `low`. `reason` names the run-time share, for example "Only 62% of executor run time is in matched stages". The application-name check is unchanged. Exit codes do not move: the comparison budgets (`--max-regression-pct`, `--regression-budget`, `--fail-on-introduced`) never read `confidence`. A consumer that passes `confidence` through, such as the Airflow operator's DAG summary, now receives `low` for runs it passed as `ok` before.
  
  **New confidence value: `insufficient`.** It is reported when neither run recorded any executor run time, so there is no work to compare. `runtimeCoverage` is `null` then. Typed consumers of `confidence` (`"ok" | "low"`) need to accept it. The dashboard banner renders it.
  
  New comparison block, in the CLI's `comparison` object, in MCP `compare_runs` and in the Markdown output (MCP returns `stagePairs` only when `include: ["stagePairs"]` asks for it, because it grows with the stage count), with `comparisonSchemaVersion: 1`:
  
  - `stagePairs`: `pairId`, `baseStageIds`, `candStageIds`, `quality`, `score` and `deltas` for executor run time, CPU time, spill, input, output and shuffle bytes. Deltas count every task attempt of the stage, failed ones included.
  - `unmatched`, `replanned` (always empty), `bookkeepingStageIds` and `runtimeCoverage`.
  - `matchedCoverage`, `baseStages`, `candStages` and the whole-run `metrics` keep their meaning. Stages that only read the Delta log or its checkpoints are reported in `bookkeepingStageIds` and counted in neither the pairs nor the coverage. A consumer that joined per-stage metrics rows by identity should read `stagePairs` instead.
  
  Stages now pair after the text that differs between runs of one job is rewritten: random staging directories, dates, `IN` lists, Delta log file counts. The new `--normalize-path <regex>` flag (repeatable, needs `--baseline`) and the MCP `compare_runs` parameter `normalizePath` add caller-supplied patterns for run-specific text such as a per-run output directory. Despite the name they are generic regular expressions. They change stage pairing only, never findings. The CLI refuses an invalid pattern with exit code 2. MCP caps a pattern at 200 characters, but a pattern that backtracks catastrophically can still stall the server.
  
  The dashboard's per-stage skew table lists the aligner's pairs and states the share of executor run time they hold.

## 0.5.0

### Minor Changes

- 7fe40c7: Evidence report finding rows gain two machine-readable fields. `remediation` lists the Spark property changes a finding's recommendation names (`{kind: "conf", key, direction, suggested}`), with `suggested` set only where the detector computes a value (for example the shuffle partition count that brings partitions to 128 MiB) and `null` otherwise. `impactEstimate.coreTimeMs` gives the busy core time a fix removes in core-milliseconds next to the wall-clock range, only where the detector measures it (GC time, retried or discarded speculative attempts, the task time a skew or straggler fix removes). It is `null`, never 0, for a finding with only a wall-clock claim, for figures modeled on an assumed constant (core locality's fetch penalty, autoscaling churn, job failures), and for findings whose waste is idle allocated capacity (utilization, idle cores), which keep their idle figure in `rawWaste` with `idle: true`. A stage's slow tail is counted once across skew and straggler. Idle core figures now read "of idle core capacity" instead of "of core time" on the dashboard, HTML export, CLI and MCP. A remediation that sets a property to a fixed value is left out when the run's logged conf already has that value, and the recommendation, including the dashboard's one-line fix for a group of findings, then points at the remaining remedy instead of that property; Spark's unlogged defaults are not modeled. When the logged shuffle partition count is already at or above what a low-parallelism stage needs, its recommendation points at the stage's own partitioning and suggests no property, and dynamic allocation suggestions are dropped when the run has it off. The report's schema version is unchanged. The core locality recommendation no longer names `spark.locality.wait`, which it gave no direction for. The autoscaling churn finding also lists the dynamic allocation min and max executor bounds its text names.

### Patch Changes

- d3a74d7: Fixes found by checking the user guide against the code.
  
  - The Stage Shape card's task-to-stage rule (`SHAPE`) now fires when the longest task runs for more than half its stage's wall-clock and over 3× the median task, on a stage that takes at least 0.5% of the run. It compared the longest task against 3× the stage's wall-clock, which a task inside its stage can't reach, so it never fired. Its value is now that share of the stage, such as 0.99, and the `stageShape` detector reports version 2 with two new tunable thresholds, `stageShareMin` and `taskStageSkewFloorPct`; `skewWarn` is now the ratio to the median task.
  - In MCP, a local file or folder that isn't a decodable event log reports `invalid-event-log`, the code a History Server archive that fails to decode already reported, instead of `access-or-upstream-failure`. `list_runs` reports `upstream-unreachable` when the History Server refuses the connection or times out, as `diagnose_run` does.
  - Redaction replaces the app name with the app id's pseudonym everywhere: `diagnose_run`, `get_run_summary`, the CLI's `--redact` report and HTML export, and the dashboard's **Redact identifiers** export, as `list_runs` already did. `spark.app.name` in the exported config is replaced too.
  - The run comparison labels its whole-run `memoryBytesSpilled` total "Memory spill" instead of "Shuffle spill". The `shuffleSpill` key is unchanged.
  - The `sparkforensics-server` `/mcp` endpoint is documented in the MCP tools guide and in `--help`.

## 0.4.0

### Minor Changes

- 8ad8560: Cache storage (`CSTOR`): the cached-partition counts and memory/disk sizes now come from
  `SparkListenerBlockUpdated` events, which Spark writes when
  `spark.eventLog.logBlockUpdates.enabled=true`. Before, the check read only the RDD Info in
  stage-submission events, whose cache figures Spark has written as 0 since 2.3, so it could not fire
  on any current Spark version. Each RDD reports its peak cache residency, so an `unpersist()` before
  the log ends no longer hides partitions that never fit. Thresholds are unchanged. RDD Info stays as
  the fallback. When a Spark 2.3+ run persists RDDs but its log has neither source and block-update logging was
  off, the check reports that cache
  storage was not logged, naming `spark.eventLog.logBlockUpdates.enabled`, instead of listing Cache
  Storage as a passed check. Block-update lines for broadcast and shuffle blocks are dropped before
  JSON parsing.
- 3fbd34b: **Breaking (MCP):** `evaluate_budgets` with two runs now applies the absolute budgets
  (`maxRuntimeMs`, `maxSpillGb`, `maxSkewRatio`, `maxFailedTaskRatePct`, `minEfficiencyPct`) to the
  candidate run (`sourceB`/`runIdB`), matching `sparkforensics-analyze --baseline`. Before, they were
  evaluated on `source`/`runId`, the regression baseline. The tool also always reports a
  `run-complete` result with status `inconclusive` when the evaluated run (the candidate, with two
  runs) has no ApplicationEnd event, the same check the CLI uses to exit 3, so a truncated log no
  longer reads as a pass. Clients that passed the run to gate as `source` alongside a `sourceB` must
  swap the two.
  
  The CLI now takes its `run-complete` check from the same shared budget evaluation. Its output and
  exit codes are unchanged.
- 98591c4: Run comparisons outside the dashboard now open with the dashboard comparison page's verdict. The CLI's `--baseline` output gains `comparison.verdict` in JSON (`title`, `tone`, `sentences`) and a verdict at the top of the Markdown "Comparison to baseline" section, which also names run A (the baseline) and run B (the candidate). MCP `compare_runs` returns the same `verdict`. It leads with failed jobs when either run had any ("Run A had 1 of 3 jobs fail; run B completed"), states the run-time change with a 2% noise band, never calls a cut-off log's shorter time faster, and names which cost metrics and finding categories moved each way. The verdict and the finding-tag names it uses moved from the dashboard into the shared core package, and the core comparison result now carries each run's job outcome, so the dashboard and the headless paths run one implementation.
- 98591c4: The evidence report (CLI md/json, MCP `diagnose_run`, and the dashboard's Export evidence download) no longer lists checks the log could not run as clean. It uses the dashboard's rule: every per-stage check on a log where no stage finished, the run-span checks (`utilization`, `memoryUtilization`, `autoscalingChurn`) on a log with no end-of-run record, and any check whose only finding is a missing-data caveat move from `cleanChecks` to a new `notRunChecks` list. Each entry carries a `reason`, and the Markdown shows them under "Not checked on this log". The summary gains `actionableFindingCount` and `actionableImpactBandCounts`, which leave out evidence caveats and the incomplete-run row as the dashboard's top bar does, and `clean`, the dashboard's clean-run rule. The report's `schemaVersion` is now 4.
- 98591c4: The evidence report and MCP `get_run_summary` now say how the run ended, as the dashboard verdict does. The report summary gains `outcome` (`failedJobs`, `totalJobs`, `failureReason`, `failureReasonStageId`), and the Markdown adds a line such as "Outcome: 1 of 3 jobs failed. Spark's recorded reason (stage 1): ...", quoting only the first line of Spark's reason. `get_run_summary` returns the same four fields next to `runComplete`. With `redact`, its app identity now comes from the same redacted report, so a host in the app name and in the failure reason get the same pseudonym.
- 98591c4: The evidence report (CLI md/json, MCP `diagnose_run`, and the dashboard's Export evidence download) now opens with the dashboard's run verdict. A new `verdict` field carries the same title, summary sentences and first three next steps the verdict card shows, in the same order: grouped by place, ranked by potential savings, with failures first on a run whose jobs failed. Each step has its action, what to try, the potential savings and what that figure counts, and the other finding types flagged at the same place. `copyText` is the card's "Copy next steps" checklist. The Markdown adds a `## Verdict` section above "Fix these first", which stays: it ranks fix types, the verdict ranks places. The verdict's ranking and wording moved from the dashboard into the shared core package, so both paths run one implementation.
- 98591c4: Savings figures in the evidence report (CLI md/json, MCP, and the dashboard's Export evidence download) now read as the dashboard prints them. Memory reads in GB-h from 0.1 GB-h up instead of MB-s, core time in core-s or core-h instead of core-ms, and a figure that rounds to zero is left out instead of printing "0.0 core-h". Each figure says what it counts ("of run time", "of core time", "of unused executor memory"): `recommendations` rows gain `impactMeaning`, finding rows gain `impact` and `impactMeaning`, and the Markdown adds a `- estimate:` line explaining how each figure was derived.
  
  **Changed output:** time figures no longer carry an "Estimated" prefix. "Estimated 26.1s" is now "26.1s of run time", in `recommendations[].impact` and in the Markdown `impact:` lines. Update any script that matched the old prefix. The Markdown `- impact:` line now carries a single figure: it used to print the time range and the raw resource figure together, joined by a middot. The resource figure behind a time estimate has moved to the new `- estimate:` line, and a raw waste in milliseconds that is below the estimate's high is no longer printed.
  
  The `--min-efficiency` budget (and MCP `minEfficiencyPct`) detail now reads "Busy core time 26% below budget 90%." instead of "Efficiency 26% ...", so it no longer reads as the dashboard's Efficiency tile, which measures something else. What the flag measures, the share of executor core time that ran tasks, is unchanged, and so are its exit codes.
- 98591c4: The CLI `--stage` filter and MCP `diagnose_run`'s `stageId` now keep a SQL plan finding whose only stage is the one asked for, such as a small-files finding on stage 3, the same rule the dashboard's Stage details uses.
  
  The evidence report summary and MCP `get_run_summary` gain `runShape`, the run-shape figures the dashboard shows: wall-clock, Efficiency (the share of the run with a stage running), Unused core time, the ETL phases' summed stage time, and the peak busy cores from Core Usage by Locality. Each is null where the dashboard shows "Not measured" or "Unavailable", and the Markdown lists them under the header with what each one measures.
  
  Run from a repository checkout, the CLI, MCP and server entry points no longer silently use a leftover `vendor-core/` built from older core sources. They use it only while it matches `packages/core/src`, and otherwise print a one-line warning and run the current sources. The packed `vendor-core/` now records the hash of the sources it was built from.

### Patch Changes

- 6b3c2ba: The Speculation waste (`SPEC`) finding now counts losing speculative attempts whose TaskEnd arrives
  after their stage's StageCompleted. Spark kills the losing copy only once the stage finishes
  ("Stage cancelled: Stage finished"), so on a real cluster this is the usual order, and the parser
  used to drop those attempts, leaving the finding silent for runs with speculation enabled. Only the
  stage's speculation waste totals change; every other stat still excludes late attempts.

## 0.3.0

### Minor Changes

- daf8d62: The Failed Tasks (`FAIL`) finding now names the error behind failed tasks instead of only Spark's
  end-reason tag: the exception class, or the executor loss reason such as "Container killed by YARN
  for exceeding memory limits". A PySpark failure's message is its Python error line (such as
  `ValueError: bad row`), not the traceback header. It lists up to five distinct failures, each with its message, loss
  reason and one bounded stack excerpt (header, first 8 frames, a Python traceback's error line and the
  last `Caused by:` line, at most 2000 characters), plus a count of failed tasks the list leaves out. The finding's `dominantReason`
  is unchanged; new evidence fields are `dominantError`, `failureGroups` and `otherFailedTasks`, and
  the `failures` detector version is now 2. With `--redact` (and `redact` in the MCP tools), messages
  and the message text inside stack excerpts are replaced, since they can carry file paths and data
  values; class names, stack frames and loss reasons stay, with hosts pseudonymized as before.

### Patch Changes

- 8891e15: Parser: the dashboard, `sparkforensics-analyze` and the MCP `path` source now take a Spark History
  Server download as-is, the `.zip` the Spark UI's download link or `GET
  /api/v1/applications/<appId>/logs` returns. A single-file log is unwrapped; a rolling log's parts
  under `eventlog_v2_<appId>/` are reassembled in index order, like a dropped rolling folder.
  Before, the dashboard reported that the file was not an event log and the CLI exited 2 with "Not a
  Spark event log", so the log had to be unzipped by hand first. Dropped zips and History Server
  fetches share one zip reader, which reads the archive's central directory and inflates one entry
  at a time in 512 KiB slices, so it never holds a decompressed entry whole. History Server fetches
  of a compacted rolling log no longer re-read the parts already merged into its `.compact` file,
  which the directory prefix used to hide from the rolling-log check.
- 13b3ccb: Package READMEs now show a working install command and one example instead of only linking to the main README.
- 6b09caf: Include the MIT `LICENSE` file in the published `sparkforensics-cli`, `sparkforensics-mcp` and
  `sparkforensics-server` tarballs, as the `sparkforensics-analyze` and `sparkforensics` packages
  already do.

## 0.2.4

### Patch Changes

- fa49bd3: Skew and straggler estimates now replay each stage's own tasks instead of estimating the tail from P50, P95 and max. The parser schedules the stage's tasks in launch order on its observed peak slots twice, once as they ran and once with every task over 4x the median capped at the median, and the finding claims the difference. Clustered late stragglers now claim more, a long task that overlapped the rest of the stage claims less, and a speculation-driven stage with no task over 4x the median claims nothing. On 14 real logs this adds 4 findings, removes 2 and re-bands 5; every non-info estimate is within 2x of the replay (98 of 101 before).
- 51d0dc8: Estimates: a `stageSlowness` finding claims no recoverable time when its stage read no input and
  no shuffle bytes and its tasks spent under 1% of their run time on CPU, since they were waiting on
  something outside Spark (a JDBC read, a file listing) that more partitions don't split. This
  replaces the rule that zeroed any stage reading no input and no shuffle bytes: a stage that computes
  from generated data, or only writes output, keeps its claim.
  Stages running Python through `PythonRDD`, and logs from Spark versions without CPU time, are
  never treated as idle, since their CPU time doesn't show the work.
- 7afca93: Parser: a dropped zstd event log now decompresses in a second web worker while the parse worker
  parses earlier output, instead of both taking turns on one thread. A window of three read slices
  bounds the output queued between the two workers, and buffers move between them by transfer. On
  the largest real log (138 MB compressed, 3.56 GB decompressed) the median browser parse time over
  six paired runs fell from 7.5s to 6.1s (18%), with identical parse output and task data. Parsing
  is now bound by fzstd itself: the decompress worker alone takes 5.1-5.3s on that log. Where the
  nested worker cannot start, parsing falls back to the previous in-thread decoder. Other codecs and
  History Server fetches are unchanged.

## 0.2.3

### Patch Changes

- 816caec: Parser: SQL execution events no longer carry or retain `physicalPlanDescription` (Spark's text
  rendering of the plan, which nothing reads), and the raw `sparkPlanInfo` is released once its plan
  tree resolves. On a 3.5 GB decompressed real log this cut parse time 7.8% and peak RSS 21%, with
  identical findings.
  
  Estimates: `skew` and `straggler` recoverable time is no longer floored at the stage's current
  longest task, the very task their fix shortens. A stage gated by one straggler used to report
  about zero recoverable time, and could be dropped by the runtime floor. Their floor is now the
  longest task the fix leaves or the stage's core work over every core. Against a task-level
  replay of 765 flagged stages on 14 real logs, estimates more than 2x too low fell from 199 to 11.
  
  Estimates: low-GC `gc` findings (an over-provisioning signal) no longer claim the stage's GC time as
  recoverable wall-clock time, since their fix, less executor memory, raises GC rather than removing
  it. They are now informational and keep their `info` band.
  
  Estimates: `shuffle` and `spill` recoverable time now spreads the stage's shuffle-read or disk-spill
  bytes over every executor that ran it (one ~1 Gbps link or ~200 MB/s disk each) instead of pushing
  the whole cluster's bytes through a single link or disk. On the largest real log the old figures
  claimed 721 minutes of shuffle and spill savings on a 458-minute run; they now claim 51.
  
  Estimates: `tinyTask` recoverable time now uses the stage's own measured per-task overhead (task
  wall time minus executor run time) spread over the stage's achieved concurrency, instead of an
  assumed 50ms per task summed serially across tasks that ran in parallel.
  
  Estimates: `stageSlowness` no longer claims "stage duration minus 15 minutes" as recoverable. Its
  estimate is now what more partitions could recover: the time the stage's tasks were running, spread
  over the cores the stage left unused. A stage that sat queued with its one short task, or that
  already ran more tasks than the cluster had cores, no longer grades critical, and a long
  single-task stage that read data now does. One that read no input and no shuffle bytes claims
  nothing, since more partitions would have nothing to split. Stage messages carry a new `taskActiveMs`
  field for this.
  
  Parser: a stage whose `StageSubmitted` event carries no submission time (older Spark) now takes it
  from `StageCompleted`, instead of starting at epoch 0 and reading as a decades-long stage.
  
  Thresholds: `straggler` also fires on a 2.5-5% straggler share when the stage's recoverable tail
  already clears the 0.5% runtime floor. In a large stage, the few tasks that gate it for tens of
  seconds can be under 5% of its tasks.
  
  Parser: the NDJSON line splitter finds newlines in the decoded text instead of mapping raw-byte
  offsets to UTF-16 offsets, 4.4% faster parsing across 14 real logs with identical output.
  
  Analyzer: plan-shape fingerprints fold each child in as a fixed-length digest instead of its
  full fingerprint string, and scan classification rejects non-scan plan nodes before running its
  regexes and is computed once per node. `analyze()` is 40% faster across 14 real logs (1131ms to
  678ms; 729ms to 311ms on the largest), with identical findings. Join-detail normalization no
  longer rescans each identifier from every letter, another 8% (692ms to 636ms).
  
  Parser: a `physicalPlanDescription` value that spans decompressed chunks is dropped as raw bytes
  instead of being decoded and then cut out as text. Parsing the largest real log is 11.7% faster
  (12.56s to 11.09s) with peak memory down from 708MB to 602MB; 6.8% faster across 14 real logs,
  with identical output.
  
  Parser: a `TaskEnd` whose accumulator updates include a JSON array (Spark 2.x's
  `internal.metrics.updatedBlockStatuses`, or block-status tracking turned on) is no longer rejected
  and dropped from its stage's stats. Only the accumulable `ID` is validated now, which also makes
  parsing 3.7% faster across 14 real logs.
  
  Estimates: `duplicatePlanSubtree` claims only repeated work it can see. Repeats with the same
  shape but different filters, columns or tables are informational with low confidence. Each stage
  now counts only the repeated operators' share of it, and only for its task-active time, so a
  stage shared with a join or left waiting for cores no longer counts whole. Across 14 real logs,
  duplicate-subtree claims fell from 2307 to 108 minutes; before, three logs claimed more duplicate
  time than their whole run.
  
  Thresholds: `stageShape`'s under-parallelization rule skips stages shorter than 0.5% of the run,
  the same runtime floor the tiered detectors use: parallelizing a stage can't save more than its
  own duration. That was 2839 of 3005 such findings across 14 real logs.
  
  CLI and MCP: zstd event logs decompress with Node's native zlib zstd, one frame at a time, when
  the running Node has it (22.15+ or 23.8+); older Nodes and the browser keep the bundled decoder.
  Parsing the 14 real logs is 42% faster (22.3s to 13.0s; the largest log 10.7s to 6.4s) with
  identical output. Logs fetched from a Spark History Server take the same path (2.3s to 1.0s on
  a 566MB log).
  
  Estimates: `skew` and `straggler` count a tail of many slow tasks as their summed excess over
  the median spread across the stage's peak concurrent tasks, not just the longest task's excess.
  Against a task-level replay of 31 runs, estimates within 2x of the replay went from 56 of 78 to
  79 of 85, none are now more than 2x under (was 16), and skew recall rose from 0.60 to 0.73 with
  no loss of precision.
  
  Estimates and bands: `coldStart` measures the wait from the first stage to the first executor,
  not the driver's own startup before its first job. That removes 6 false positives on 14 real logs
  and 6 on the corpus, where executors were up long before the first stage. A `smallFiles` read
  spreads its per-file cost over the tasks that opened the files in parallel.
  
  Parsing: an adaptive query execution update that a later update for the same running SQL
  execution replaces is no longer parsed, since only the last plan is ever used. Parsing the 14
  real logs is 13% faster (13.1s to 11.3s; the largest log 6.3s to 5.4s) with identical findings.
  
  Parsing: large decompressed chunks are decoded in 512 KiB slices, so a SQL event's
  plan text is dropped undecoded even when one zstd frame holds all of it. On the largest real
  log that is 1.8 GB of text never decoded, and its parse is 13% faster (5.4s to 4.7s).
  
  Parsing: a task-end event's accumulator IDs are read without parsing the rest of each entry,
  which is 71% of those events' bytes. Parsing the 14 real logs is 11% faster (10.6s to 9.4s) and
  the 52 corpus logs 8% faster, with identical findings.
  
  Dashboard: zstd event logs decompress about 4x faster in the browser (the bundled decoder
  decodes every block into one reused buffer instead of allocating and shifting a window per frame
  and a buffer per block, and copies long runs natively), with byte-identical output on the 14 real
  logs. Decompressing the largest one in Chrome takes 2.9s instead of 11.6s.
  
  CLI and MCP: large zstd frames of a local event log decompress on Node's threadpool while the
  main thread parses. Parsing the 14 real logs is 14% faster (9.4s to 8.1s; the largest log 4.2s
  to 3.2s) with identical findings, for up to 139 MB more peak memory.
  
  Estimates: the `skew` and `straggler` core-work floor now leaves out the task time their fix
  removes. A stage whose stragglers were most of its core time was floored near its own duration:
  one real stage claimed 5.9s where a task-level replay recovers 38.7s. Against that replay over 65
  runs, estimates within 2x of it went from 88 of 95 to 97 of 103 and mean absolute error from
  7.55s to 5.18s; skew recall rose from 0.76 to 0.81 (precision 0.98 to 0.96).
  
  Estimates: a `straggler` claim runs from the stage's longest task down to the longest task the
  fix leaves (the longest one at or under 4x the median), not down to the median: a stage with a
  task just under 4x the median still waits on it. Stage messages carry a new
  `longestNonStragglerMs` field for this. Against the task-level replay over 65 runs, estimates
  more than 2x too high fell from 6 to 4 and mean absolute error from 5.18s to 4.49s. `skew` now
  takes the same floor. Before, a 100s stage whose next-longest task ran 39s had skew claiming 90s
  where straggler claimed 61s. Overestimates fell to 3. Mean absolute error fell to 4.12s.
  
  Parsing: an adaptive query execution update is recognized from the first and last pieces of its
  line as decoded, so an update that a later one replaces is no longer copied into one string only
  to be dropped. Parsing the 14 real logs is 3% faster (8.05s to 7.80s; the largest log 6%, 3.16s
  to 2.97s) with identical findings.
  
  Estimates: `retryWaste` no longer claims the summed time of its wasted attempts as wall-clock when
  those attempts ran side by side. When every wasted attempt is sampled, the claim is the longest
  retry chain (one task's repeated failures) times the mean wasted attempt, or the summed time spread
  over the stage's slots when larger. Four tasks lost with one executor on a real stage claimed
  146.6s and now claim 36.6s.
  
  Estimates: a `shuffle` claim can no longer exceed the shuffle fetch wait its tasks measured,
  converted to wall-clock at the stage's average concurrency. The per-link bandwidth model can't
  see whether reads stalled the tasks: on 14 real logs it claimed 2780s over 284 shuffle findings,
  and the capped figure is 256s. Five of the ten warning or critical shuffle findings had about
  zero fetch wait and are now informational.
  
  Thresholds: low-GC notes and `straggler` findings skip stages shorter than 0.5% of the run, the
  floor `stageShape` already uses. Every such straggler finding graded info, since a tail can't
  cost more than its stage's own duration, and a memory-sizing note from a stage that barely ran
  adds nothing. On 14 real logs that drops 464 low-GC notes and 671 straggler findings, all
  informational; high-GC, warning and critical findings are unchanged.
  
  Thresholds: `slowHost` and `tinyTask` skip stages shorter than 0.5% of the run too. A slow host or
  tiny tasks can't cost more than such a stage's own duration, so every finding there graded info.
  On 14 real logs that drops 324 slowHost and 132 tinyTask findings, all informational; warning and
  critical findings are unchanged.
  
  Thresholds: `shuffle` and `spill` findings skip stages shorter than 0.5% of the run as well. Their
  claims are clipped to the stage, so every such finding graded info. On 14 real logs that drops 182
  shuffle and 12 spill findings, all informational; warning and critical findings are unchanged.
  
  Thresholds: a `duplicatePlanSubtree` repeat whose stages together lasted less than 0.5% of the run
  is no longer reported. Its claim counts at most those stages' own time, so every such finding
  graded info. On 14 real logs that drops 340 of 545, all informational; warning and critical
  findings are unchanged.
- 8df894a: Finding docs links now open the section written for each finding: partition sizing, speculation
  waste, core locality, caching opportunity, cache utilization and autoscaling churn (which had no
  docs link before) each link to their own tuning-reference section instead of a shared parent
  page. Config audit tags link to the audited property's section when the tag stands for one
  property, instead of skipping the tuning reference. `get_finding_documentation` returns the owning
  chapter for autoscaling churn and cache utilization, whose sections live on a general chapter,
  instead of `tuningDoc: null`.
- fb33493: Tuning reference refreshed to spark-tuning-reference@1d0f90d: corrected detector threshold tables
  for failures, GC, shuffle, skew, small files, straggler, tiny tasks and utilization, and new
  sub-anchor sections for autoscaling churn (cluster config), cache utilization (memory model),
  speculation waste (straggler), partition sizing (shuffle), core locality and caching opportunity
  (utilization). The reference is now pinned to an exact upstream commit, recorded in the vendored
  docs as `upstream.json`.

## 0.2.2

### Patch Changes

- 97732c9: Bump vitest and @vitest/coverage-v8 from 4.1.11 to 5.0.1 everywhere (root, packages/core, packages/cli, packages/mcp). This also collapses packages/server's own already-bumped `vitest@^5.0.1` back into a single hoisted install, since every workspace member now shares the same major version.
  
  Two config changes went with it: `vitest.config.js`'s `poolOptions.threads.{execArgv,maxThreads}` moved to the top-level `execArgv`/`maxWorkers` options per v5's pool-options rework, and `packages/core/vitest.config.js` now excludes `src/docs-content/**` from coverage: v5's coverage-v8 remaps uncovered files through Rolldown, which errored trying to parse that directory's markdown reference content as JS.
- d5b9987: `CachingOpportunity.tsx` now renders each finding's own confidence badge next to its row instead of a single shared low-confidence caveat below the table, matching the `cachingReuseConfidence` scaling the `cachingOpportunity` detector already applies per finding. Docs across `docs-content/detection` (`cache.md`, `chrn.md`, `local.md`, `mem.md`, `spec.md`) and `docs-site/contributor-guide/architecture` (`board-widgets.md`, `detector-contract.md`, `impact-estimation.md`, `state-and-history.md`, `widget-rendering.md`) now describe scaled `low`/`medium`/`high` confidence instead of a hardcoded value for `cachingOpportunity`, `autoscalingChurn`, `coreLocality`, and `memoryUtilization`'s waste-model, and `widget-rendering.md` drops `CachingOpportunity.tsx` from its confidence-exception list now that it's down to one named exception.
- 649ab3c: Fixed three CodeQL security alerts: the local server no longer interpolates
  the request method/URL into a `console.error` format string (a malformed
  request could otherwise corrupt the logged message); the static-file server's
  path-traversal guard now resolves the request path with `path.resolve`
  instead of `path.normalize`/`path.join`, matching the pattern CodeQL
  recognizes as sound; and the docs-site copy step's regex-escaping helper now
  escapes every regex metacharacter, not only `/`, when building the pattern
  used to rewrite absolute `/docs/...` references.
- 5cb0779: The landing page now probes for a reachable local Spark History Server (an empty `fetch(/shs-proxy)` that returns 400 when a server is present, versus a network error or 404 on a static deploy) and, when one responds, shows a neutral callout above "Other sources" pointing the user at the disclosure to fetch a run from it directly. The disclosure itself still doesn't move or auto-expand, and nothing renders until the probe resolves, so a static deploy with no server sees no change.
  
  The "Fetch from Spark History Server" and "Other sources" toggles now show a chevron that flips between down and up as each opens and closes, instead of only changing `aria-expanded` with no visual difference. The Base URL, Application ID, and Attempt ID fields also remember their last values across visits, so a returning user isn't retyping them.

## 0.2.1

### Patch Changes

- 7719736: Add coverage collection to each package's vitest config and CI job, reporting to Coveralls.
- 5af79cd: Clarify two beginner-facing messages. The "not a Spark event log" parse error now says "no application-start event found" and points to the docs instead of naming the internal `SparkListenerApplicationStart` event class. The Scorecard's wall-clock and efficiency tiles spell out "No stage activity recorded" for a zero-activity run instead of chaining into the shared `—` "no value" glyph, which read as broken data rather than an empty run.
- 5af79cd: Topbar now carries a "New analysis" home button and a persistent Docs link once a run is loaded, since both previously existed only on the landing screen and there was no way back. Finding-type tags that link to a doc page now get a visible underline so they read as linkable at a glance instead of only on hover; `incompleteRun` (INCMP), which had no vendor doc anchor, now links to its SparkForensics guide entry instead of rendering as inert text. FixTheseFirst's grouped-row trailing stat ("×2 · 476ms recoverable") now carries a spelled-out tooltip explaining the shorthand.
- 5af79cd: The landing page now offers a "Try a sample run" option for visitors who don't have a Spark event log of their own. It loads a bundled, gzip-compressed real event log (picked by running the analyzer over every corpus candidate and taking the one with the most findings) so a first-time user can see the dashboard without hunting for their own data.
- ac586b2: Bump `react-dom` and `@types/react-dom` to 19.3.0, and `react` and `@types/react` to the matching `^19.3.0` so the peer-dependency ranges resolve without `--force`/`--legacy-peer-deps`.
- bbd90eb: Bump zod from 4.4.3 to 4.6.5.
- eb92d78: Exclude the vendored decompressors (fflate, fzstd) from packages/core's coverage report, matching the root config, and add tests for previously-uncovered core logic (finding-action-label, model-assembler, format-utils, parser-worker's multi-file error paths, ingest's worker-message routing). No runtime behavior change.
- 50c7b4b: Spell out "Estimated" instead of "Est." for the wall-clock impact prefix in the Markdown evidence report. The abbreviation only saved space in the web UI; the Markdown report now reads as a full phrase.
- 4981e0e: Vary confidence for eight more findings (skew, gc, straggler, speculationWaste, memoryUtilization's waste-model, coreLocality, autoscalingChurn, cachingOpportunity) with the strength of their underlying evidence instead of hardcoding `'low'`. Each now scales off that detector's own existing thresholds: skew and gc score how many multiples past their ratio/percentage floor a finding sits; straggler, speculationWaste, memoryUtilization and autoscalingChurn do the same against their own warn/critical tiers; coreLocality additionally weighs task-sample size, taking whichever signal is weaker; cachingOpportunity scales with how many executions repeat the same relation or plan shape past the minimum needed to fire at all.
- 91d197a: Vary confidence for the cacheUtilization and duplicatePlanSubtree findings with the strength of their underlying evidence instead of hardcoding `'medium'`. cacheUtilization's per-RDD cached/disk ratios now scale confidence with `numPartitions`: below 10 partitions a single partition flipping cached/evicted swings the reported percentage too much to trust (`low`), 50+ partitions makes the ratio stable (`high`). duplicatePlanSubtree's structural-fingerprint match (operator + metric names only, not literal values) now scales confidence with how far the matched subtree clears its own thresholds: a match at the bare minimum size and occurrence count is the case most likely to be coincidental (`low`), while a much bigger or more-repeated match is strong corroborating evidence (`high`).
- 0a8600d: Remove "unvalidated"/"unverified" hedging language from finding caveat text, the What-If Executor Scaling widget, and the design-spike confidence badge. The `confidence` field and its tooltip mechanism are unchanged; only the prose describing findings as uncalibrated against an external tool was reworded.
- 198b5c2: Run comparison's `confidence` field now also drops to `low` when matched stage coverage is below 50%, not just on an app-name mismatch, so two same-named runs that barely share any stages no longer report `ok`.
- a2e71e4: Bump vitest to 5.0.1 in packages/server and sync the root lockfile with it. Remove packages/server's own package-lock.json: as an npm-workspaces member, CI only ever installed from the root lockfile, so the nested one was dead weight that a directory-scoped Dependabot update could drift out of sync with (as this bump did, breaking `npm ci`). Dependabot's `/packages/server` entry is removed too, since the root entry already covers every workspace member's dependencies.

## 0.2.0

### Minor Changes

- 438e1b7: Bump to 0.2.0, rolling up the accumulated feature work since 0.1.0 (HTML
  export, run listing, widget catalog rework, and the other pending fixes)
  into one minor release across all three published packages.

### Patch Changes

- 438e1b7: Fix Executor Utilization and Memory Utilization overstating idle time and
  wasted-memory savings on runs with executor churn (spot preemption,
  `dynamicAllocation` replacement): both now measure real concurrent capacity
  instead of summing every executor that ever existed.
  
  `maxPartitionTooBig`, a hardcoded-critical OOM/crash-risk finding, no longer
  gets silently downgraded on long-running jobs by the generic wall-clock-based
  severity grading; it keeps its critical severity regardless of how small its
  modeled time savings are relative to the run.
  
  Cold Start and Executor Utilization no longer silently skip a run whose
  `startTime` is literally `0`.
  
  Task Skew and Straggler findings on the same stage now call out that they
  can describe the same wasted time and shouldn't be added together. Task
  Skew, Straggler, and GC Pressure now disclose that their thresholds are
  unvalidated, matching other findings with comparable uncertainty.
- 438e1b7: Executor Utilization and Memory Utilization no longer show a "no issues"
  card in the dashboard when they have zero findings; they now collapse into
  the Clean-checks row like every other widget instead of being always
  mounted. Core Usage by Locality keeps the always-mounted treatment.
  
  The CLI's `--format md/json` report and MCP's `diagnose_run` output change
  to match: when Executor or Memory Utilization has zero findings, it's now
  listed under "checked and clean" like every other detector, instead of
  being silently omitted from that section.
- 438e1b7: Add the `list_runs` MCP tool, which finds candidate Spark runs in a local
  directory or on a Spark History Server (by name pattern, date range, capped
  count) before diagnosing one with the other tools.
  
  `stageFailed` and `retryWaste` findings now carry up to 20 sampled
  failed/retried tasks each (task id, attempt number, host, executor, failure
  reason, peak executor memory, spill, shuffle write), instead of only a
  stage-level count. Redaction now walks every field literally named `host`
  anywhere in the findings tree, so these new samples get host-redacted too.
  
  Fix `compare_runs` stage matching under-reporting coverage: identities that
  collide the same number of times on both runs now pair off positionally
  instead of being dropped as ambiguous, and a stage's SQL identity is scoped
  to only the plan nodes that stage actually ran instead of the whole plan
  tree. Together these recover matched coverage on self-comparisons and on
  comparisons involving repeated stage shapes (e.g. a self-join's two Exchange
  stages).
  
  Rework the recommendation copy for slow-host and straggler findings so it no
  longer presumes a hardware fault by default, pointing at data locality and
  `spark.speculation` instead. Stage-slowness recommendation copy now points
  at shuffle-partition tuning. Fix the plan-node-detail parser so operators
  with no dedicated branch (e.g. `InMemoryTableScan`) no longer repeat their
  own name as a duplicate prefix in the parsed detail text.
- 438e1b7: Memory Utilization no longer shows as an active widget when its only
  finding is the `dataUnavailable` caveat (missing evidence because
  `spark.eventLog.logStageExecutorMetrics` wasn't enabled for the run): that
  caveat is already surfaced in the Evidence availability ledger, so it no
  longer counts toward the widget's active-vs-clean decision. It now collapses
  to the Clean-checks row in that case, matching the dashboard bundled into
  the server and into the CLI's `--export-html` output.
- 438e1b7: Add a package README pointing at the main repo README, and make `--help`
  print usage instead of silently starting the server (mcp and server bins).
- 438e1b7: Speed up NDJSON event-log parsing ~4x (byte-scan line splitting, whole-chunk
  decode with substring lines). Make the server bin executable and serve nested
  directory-index requests.
- 438e1b7: Add the `get_reference_doc` MCP tool, which serves the Spark tuning reference
  by anchor. The reference is now sourced from the docs-site markdown chapters
  (single source) instead of vendored built HTML.
- 438e1b7: Rename the vendored Spark Tuning Reference's docs-config directory constant
  from `spark-doc` to `spark-tuning-reference`, matching the real upstream repo
  name and the hub's product-bar surface key.
- 438e1b7: Vendor upstream's per-chapter docs pages instead of a single monolithic
  page, memoize the detector-to-doc-anchor lookup, and single-source the
  bottleneck sub-anchor mapping between docs-config.ts and update-docs.mjs.
