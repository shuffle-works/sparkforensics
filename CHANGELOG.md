# sparkforensics-web

## 0.31.0

### Minor Changes

- bd7499c: The comparison verdict calls out differences that make a time gap hard to read. It says when mean executors differ by more than 1.5 times and the wall clock moved the way fewer or more executors predict, so the wall-clock change reflects executor availability, names a differing `spark.yarn.queue`, and says the plans differ when more than 20% of the baseline's stages have no match (re-planned leftovers included) or the task count changes by more than 25%, with the unmatched stages' share of the baseline's executor run time. A differing `spark.jars`, `spark.submit.pyFiles` or `spark.yarn.dist.*` path reads as a likely code change. When every stage pairs, a task count change reads as a task count change, not a plan difference, and also shows when configuration and plan agree. `comparability.caveats` carries the same facts. The CLI flags `--executor-ratio`, `--unmatched-stages-pct` and `--task-count-change-pct`, and the `compare_runs` inputs `executorRatio`, `unmatchedShare` and `taskCountChange`, change the limits.
- be0eb32: The core locality finding counts the hosts the run used, names the stages with the most non-local tasks and states the effective `spark.locality.wait`. It carries a `remediation` that raises that property when some tasks in the stages with non-local tasks reached process- or node-local placement; when none did, it says a longer wait will not help and carries no remediation. Its core-time figure states the fetch cost it assumes per non-local task.
- 335de8b: The built app page carries a Content-Security-Policy that limits the page's own requests to its origin, and a new user guide page, "What stays on your machine", lists which modes contact the network. A browser test (`npm run test:e2e`) loads the sample run and the docs panel and fails on any request from the page, its workers or the docs iframe to another origin.
- 7d2f0ec: `FAIL`, `SFAIL` and `RETRY` findings give a specific fix when the failure text is a known message. A container killed for exceeding memory limits points to `spark.executor.memoryOverhead`. A stage that failed the maximum allowable number of times points to `spark.stage.maxConsecutiveAttempts`. Each adds a structured remediation, and the raw failure text stays on the finding.
- 7981ed4: "Show evidence" opens the finding's evidence as a flat panel that is already expanded, so the evidence takes one click instead of two. The panel has a left rule in the finding's impact color and the card heading, no border, chevron or collapsed summary, starts at the finding text column in the Findings list, and stacks at phone width. Under a verdict step or a Findings row it leaves out what that line already shows: the tag, the fix sentence, the stage chip, the savings and the figures in the finding's sentence. A finding whose line already says everything gets a short panel. The widgets are unchanged in the Full app report and the stage dialog.
- c721593: In the plan graph, a finding chip or a "Stage N" title opens that stage's findings beside the graph, in the panel the node detail uses (a right-hand dock, or a bottom sheet on a phone). The selected stage's box gets a ring. The panel shows the same tag, "What's happening", "What to try" and hidden-notes count as Stage details, and "Open full stage details" opens that dialog over the graph. Escape closes one level at a time: the dialog, the panel or node detail, then the graph. The tag in the panel links to the docs. Chips and titles have a larger click area, and the finding chips of a stage with no box of its own stay clear of the headers of other stages.
- 4d74c44: The plan graph, the "Open plan graph" picker and Stage details hide info findings by default, like the Findings list. "Next problem" skips stages that only have info findings. The graph's Settings has a "Show info notes" checkbox with the count of info findings in the run. Stage details shows how many info notes it hides, and lists them when the dashboard's info impact pill is selected.
- 3ef528e: Info findings are hidden by default. The CLI report and `diagnose_run` list critical and warning findings, and `notesHidden` counts the info findings left out; the Markdown report says so too. `--impact critical,warning,info` and `minBand: "info"` list every band. The dashboard's Findings list leaves out info findings until the impact filter names the info band, and a line above the list counts the hidden notes and says to select the info impact pill to show them. `Findings to act on` counts critical and warning findings only. The Markdown report lists a host or executor that lags in several stages once, with a line of evidence per stage.
- 175b70d: A new `joinKeyCast` finding (tag `PLAN`, informational) flags a sort-merge or shuffled hash join whose key carries a cast, such as a decimal column joined to a bigint column, when an exchange after the join shuffles by the uncast column again. The join output is partitioned by the cast expression, so the next operator cannot reuse it. The finding names the join, its cast keys and that exchange, and its value is the exchange's data size. The advice is to give both join columns the same type before the join. It is not flagged when the exchange would stay without the cast: a repartition the job asked for, an exchange that does not cover every key of the cast side, an exchange before a later join whose keys are not exactly the cast side's keys, an expand or union after the join, a full outer join, or a cast only on the side the join's output partitioning does not follow. Exchange keys that hold a comma, such as `cast(k as decimal(20,0))`, are now parsed whole in the plan summary.
- 8ecc03a: The landing page lists eight detectors and links to the detector catalog, and the next-steps rail has a Gate it in CI card.
- 901d314: A new `mergeRewrite` finding (tag `PLAN`) flags a Delta MERGE that rewrote mostly unmodified rows or skipped few files. It fires when the MERGE rewrote at least 100,000 unmodified target rows and at least twice the rows it changed, or when it kept at least 90% of 8 or more target files after skipping while its changes touched at most half of the partitions it scanned. Its text is the advice and its evidence holds the row, file and partition counts and the target. The card names each row by its SQL query and target, merges MERGE commands with identical counts into one row, and hides its Impact/Stage sort buttons when no row has a stage. The advice is to filter the MERGE source to changed rows, repeat the partition range in the MERGE condition, and check the target's file layout. `--thresholds` changes `minCopiedRows`, `minCopiedToChangedRatio`, `minTargetFiles`, `minFilesKeptShare` and `maxTouchedPartitionShare`.
- d1940d5: A new `rightSizing` finding (tag `UTIL`) says how many cores a run needs. It takes the smallest core count whose modeled stage time stays within 10% of the observed time, and reports it when that is at most 75% of the cores held at peak on a cluster of at least 8 cores, with the modeled and observed times in its text and evidence. It is always low confidence and stays silent when the model misses the observed stage time by more than 20%. `--thresholds` changes `tolerancePct`, `maxCoreShare`, `minBaselineCores` and `maxModelErrorPct`.
- bede8a6: A shuffle partition skew finding names a single key when the median partition is empty and the largest partition holds at least 90% of the stage's shuffle read. It says almost all rows share one key (often NULL or a constant), so more partitions will not help, and advises a broadcast hint, filtering or splitting out the NULL rows, or giving them a random key. The finding carries `evidence.singleKey`. When the same stage also has a missed broadcast, the finding points to it, including when automatic broadcast is disabled.
- fda4639: The spill finding sizes the memory each task slot has. When a volume spill's task peak is near that share, it advises lowering `spark.executor.cores` and names the shuffle partition count that reaches 128 MiB per partition. Under AQE coalescing it also names `spark.sql.adaptive.coalescePartitions.minPartitionNum` when `spark.sql.adaptive.coalescePartitions.parallelismFirst` is on.
- 3ef528e: Spill findings name where the spill sits. Each operator carries its plan `arguments` (a sort's keys) and a sort's `global` flag. Each exchange carries its `partitioning`, `partitions` and `origin`, and the finding says when the partitioning is the job's own `repartition(n)`, so `spark.sql.shuffle.partitions` does not change it, and advises raising that `repartition(n)` count instead. Plans from Spark 3.0 to 3.3 are read too. `evidence.sqlDescription` holds the description of the SQL execution, and the wide-rows sentence gives the column count. The dashboard's spill row shows the operator arguments, the exchange partitioning and the SQL description.
- 912e726: A new `unprunedScan` finding (tag `PLAN`, info, low confidence) flags a scan of a partitioned table that filters the rows it reads but has no partition filter. It fires when the scan reads at least 2 partitions and 1 GiB with an empty `PartitionFilters` and a row filter beyond null checks. The plan does not name the partition columns, so the finding asks you to confirm which columns partition the table. Its evidence holds the table, the partitions read and the filters. `--thresholds` changes `minBytesRead` and `minPartitionsRead`.

### Patch Changes

- 1b91a8a: Six dashboard and test fixes. A route to a finding lands on its own row after a switch to another run, because rows register under the core finding key. The core-usage histogram loads for each run. The Scorecard cold-start note ignores the finding filter. Pinned stage deltas leave volume and count metrics neutral. The partition hint appears only when the finding says `spark.sql.shuffle.partitions` sized the stage. Corpus-backed tests fail in CI when the corpus is missing instead of skipping.
- 1d932f0: Each detector docs page shows the dashboard's own widget for its example finding, with its charts and tables, instead of a plain card. A finding the run's verdict leads with appears as a verdict step ("What's happening", "What to try", potential savings); any other appears as a Findings row. Both open with the evidence panel expanded. The widget follows the docs page's light or dark theme and fits phone width. An HTML export, and so the docs widgets, offers the Task detail toggle only where it has something to show: an export carries no task data, so the toggle no longer opens to an empty section. A step or row whose widget has nothing to show beyond the line above offers no "Show evidence" control and no empty panel, in the dashboard and on the docs pages, and a route to it still lands on it. The docs widgets leave out the step labels, and each example shows a potential saving large enough to weigh.
- 32f661d: The evidence panel under "Show evidence" always shows evidence. The grid, the Full app report and the stage dialog are unchanged. Executor Utilization shows its core-time breakdown and the core usage chart, Memory Utilization the chart, the heap peak or the allocated memory-time. The panel leaves out a core usage chart with fewer than 3 points. Excessive Small Files shows the average file size, Config Audit the audited setting when it has no docs link, Shuffle I/O the per-task read sizes and Speculation Waste the speculative task count. The memory waste finding carries its allocated memory-time for the panel; the CLI and MCP evidence rows leave it out.
- 0ce80e9: In the plan graph, each stage is drawn as one box with its name, duration and finding chips once, instead of two nested boxes. The box carries the selection ring and wraps only the plan segment the log pairs with that stage, so it never encloses a node of another stage. A segment with no stage pair of its own is drawn as a dashed box that names the nearest stage. A focal stage with findings but no paired segment gets no box: its name, duration and finding chips sit in a header above the graph, with a note that it is not matched to a part of the plan. The box is also drawn in the single-stage view, and it leaves no unused room under its content.
- 0b400dd: Every verdict step and Findings row opens its own "Show evidence" panel, showing only its own finding. A second finding of a type no longer sends you to another finding's panel. A route from the Stage Summary, the stage dialog or a group member's row opens the panel that holds its finding, or the type's full card when no step or row holds it. The Stragglers panel shows the straggling task count and the stage's task duration spread, with a histogram. The Slow Executor Host panel shows the executor's measured amount and the Nested Loop Joins panel the join node, type, condition and input rows. The empty-panel test counts a panel with only a stage chip, stage name or call site as empty.
- f0e1ac4: The Impact/Stage sort switch on a findings card shows only when the Stage order differs from the Impact order. It stays hidden when the Stage order adds no stage information: the rows share one stage, have none, or are already in stage order.
- 4a10068: Guards keep the dashboard's evidence panels decided from data. `npm run lint:structure` runs ast-grep rules that ban reading rendered output to decide what to render (DOM probes, observers, clones, text reads), hiding output with a flag, DOM queries in widgets, impure content checks and hand-built evidence panels. Behaviour tests check that each widget's content check matches its panel, that closed panels mount no widget, and that a route to each example finding lands on a visible element of that finding.
- 069cb67: Tuning reference refreshed to spark-tuning-reference@8d2ffd8 (https://github.com/shuffle-works/spark-tuning-reference/compare/1d0f90dce8c0e04ad0ee6f1f724ae28d821b42cd...8d2ffd84739f5d935077037cdf5217088821e757).

## 0.30.2

### Patch Changes

- cf91d4d: The autoscaling churn finding measures only executors that were removed. An executor still alive at app end no longer counts as short-lived, so short runs and late scale-ups no longer raise a false critical. The 5-executor floor applies to removed executors, and the finding text, threshold summary and widget now say the share is of removed executors.
- 3cfa7ce: Eyebrow labels, widget bodies, verdict text, finding rows and the stage dialog keep the spacing their markup asks for. The widget grid no longer scrolls sideways at 320px, and the run name in the top bar keeps a minimum width. Spacing roles (`tight`, `label`, `para`, `card`, `section`) are documented in the contributor guide.
- ce35800: Analysis of very large logs (tens of thousands of stages, millions of tasks) scales linearly where it was quadratic, and no longer throws on a 150k-stage run. Finding de-duplication, SQL-execution stage lookup, merge-write overlap detection, executor-removal cache cleanup and wide plan-tree parsing each avoid a scan per item, per-task core usage is computed from typed arrays, and `computeRunMetrics` and the budget checks no longer spread a per-stage array into `Math.max`. The dashboard prefetches task data in one store update, groups findings by stage once, memoizes the timeline and builds a plan tree only when its section opens. Findings and estimates are unchanged.
- 4a73be8: The plan graph opens on the next node filter that shows an operator when I/O only or Basic would show none, such as a stage that only generates and writes rows. The empty modes are disabled in Settings with a short reason. The saved choice stays for other stages.
- 7a27c54: The idle-allocation finding (`utilization`) ranks by its idle core time on the same axis as stage task time, so it can lead `verdict.steps`, `recommendations` and the dashboard lists, which it usually does below 50% utilization. It is always a warning, where it was always info.
- 959e02b: Findings rank by the task time of the stage they sit on (`impactEstimate.stageTaskMs`), so `verdict.steps` and `recommendations` give the same order. The spill estimate adds the serialization and sort CPU of memory spill and states its assumptions. A `critical` finding needs its stage to carry at least 2% of the run's task time, or it drops to `warning`. Failures and oversized partitions stay `critical`.
- f3359b8: The dashboard's widget lists and the plan graph's "Next problem" order findings as `verdict.steps` does (stage task time, then potential savings), and show the Impact / Stage toggle whenever that order can move a row. The spill finding's modeled serialization and sort CPU now counts in its `coreTimeMs` and in the cost lane.
- d9d4dde: `--redact` (and the MCP `redact` parameter) now pseudonymizes the host of every URL (`hdfs://`, `jdbc:`, `spark://`, `s3a://`), `host:port` property values under any key and each stage's per-host statistics, and replaces user names in URL credentials, `/user/`, `/home/` and `/Users/` paths and `user=` values with `redacted-user`. Hosts are replaced in a single pass, so a run with hundreds of hosts and tens of thousands of stages redacts quickly. The help text and the CI guide list what `--redact` covers and what it leaves as written.
  
  The Markdown report (`--format md`, MCP `format: "md"`) now prints the application name and other log-controlled text on one line with `[ ] < > |` escaped, so a name from another team's log cannot add a heading, a link or an HTML tag to a report pasted into a pull request or ticket.
- 5105a8c: `--redact` (and the MCP `redact` parameter) replaces a single-word URL host, such as the bucket in `s3a://data/logs`, only inside the URL. A bucket named `info` or `shuffle` no longer rewrites finding fields such as `type` and `impactBand`, which made `--redact` and MCP `diagnose_run` with `redact: true` fail or return wrong values, and it no longer rewrites the same word in recommendation text.
- 3a407c0: A repeated plan subtree under a `show`, `showString` or `collect` action is informational and no longer leads the verdict. Repeats that read different recorded versions of one Delta table get no cache advice.
- 5a774d9: A failure in one widget, a stale chunk, a parse that fails after the log is read, or an HTML export with a missing or damaged `data.js` now shows a message with a way to recover, instead of a blank page or an endless "Parsing" screen. The parser worker reports a rejected parse (for example a file that changed after it was dropped) as an error.
- 121f02e: Partition-count advice no longer says AQE coalesced a stage's shuffle or blames AQE skew splits for its extra tasks, when the stage's exchange has no `AQEShuffleRead` over it, as with `repartition(n)`. Those stages point at their own partition count and executor memory, not `spark.sql.adaptive.advisoryPartitionSizeInBytes`.
- dcb95f7: The modeled spill CPU divides `diskBytesSpilled` by the bytes the stage read, so it no longer saturates on the deserialized `memoryBytesSpilled`. It charges 50% of the stage's task time per pass, capped at 60%, as measured on local sort stages.
- 223a50c: The Spill widget lists the operators that spilled, the spill-to-input ratio and the width of the rows they read. The plan graph shows the column count and bytes per row on every exchange. The parser keeps the `Input [N]` line of each Exchange in the plan description, so an exchange above a join or an aggregate gets an exact column count. On a scan stage the spill finding says a high ratio can also come from Parquet compression.
- 0c34405: The spill finding names the operators that spilled, with their plan node ids and spill size, and shows the memory spill as a multiple of the stage's input. From 10x it says the rows are wide. Its evidence adds `operators`, `spillToInputRatio`, `wideRows` and `exchanges` (column count and bytes per row).
- 84eba1d: Core-time step buttons, the docs theme switch and docs footer links have a 24px minimum target. Chart axis ticks and the tuning reference labels are 11px or larger. The docs theme switch has an accessible name, the docs home has a `main` landmark, and docs scrollbars and form controls follow the theme. Dialog and sheet scrims no longer blur the page.

## 0.30.1

### Patch Changes

- 173d54d: Partition-count advice on tiny-task, spill and slow-stage findings now names the lever that sized the stage: `spark.sql.shuffle.partitions` when the stage ran that many tasks, AQE's advisory partition size and `parallelismFirst` when AQE coalesced it, and the stage's own `repartition(n)` or RDD parallelism otherwise. Slow-stage advice no longer offers `spark.default.parallelism`.
- 531fd1a: Parsing a large event log is about 8% faster: a TaskEnd's accumulator IDs skip schema validation, a stage's repeated accumulator ID list is recorded once, and the executor-metric field table is built once. Findings and estimates are unchanged.
- 9920857: `--redact` now replaces each executor's removal reason, so the HTML export no longer keeps a file path or data value from an ExecutorRemoved event's Removed Reason text.

## 0.30.0

### Minor Changes

- 052cce9: The MCP `diagnose_run` answer is compact by default, and every finding has a key that matches across reruns. **Default change for MCP clients:** `diagnose_run` returns `view: "compact"`, which lists one short row per finding (`id`, `key`, `type`, `tag`, `name`, `impactBand`, `stageId`, `actionLabel`, `metric`, `value`, and the savings figure) and leaves out `cleanChecks`, `notRunChecks` and each finding's evidence, remediation and estimate. The verdict, `recommendations`, `metrics`, `writeTargets` and `effectiveConf` stay. On the bundled sample run the answer drops from about 42,000 to about 25,000 characters. Pass `view: "full"` for the earlier shape; `get_finding_evidence` returns one finding's full row by `id`. The CLI output does not change.
  
  - Each finding row (CLI JSON and MCP) has a `key`: the finding's type, rule and location, where a stage is the fingerprint that keys `metrics.stages`, an SQL execution is a digest of its stages' fingerprints, and a configuration finding is its property. It is a pairing aid for the same job across reruns, not a unique id and not a claim about whether the finding's value held. Findings are matched and ranked as before.
  - `compare_runs` rows list the keys of the findings they count: `keys` on introduced and resolved rows, `keys` and `baseKeys` on changed rows (CLI `comparison.findings` too).
  - `diagnose_run` takes `maxFindings` and `minBand` to limit the finding rows, reports `findingsOmitted`, and puts the lead finding row in each `verdict.steps[]` object as `leadFinding`.
  - With `format: "md"`, `diagnose_run` returns a small `structuredContent` (`runId`, `runComplete`, `title`, `findingCount`, `findingsOmitted`, `recommendationCount`) instead of the full report.
  
  Report schema 5 and metrics schema 1 are unchanged; every new field is additive.
- ceda2e8: A run comparison now says what differs between the two runs, why the time moved and whether the output is the same. `comparison.comparability` (CLI JSON, `compare_runs` and the dashboard) holds the Spark configuration keys that differ, whether every stage pairs, input bytes, output rows and output bytes of both runs, the mean and peak executors, the overlap of the run windows and the ratios that bridge the wall-clock difference (task time, mean executors and task time's share of allocated core time). The verdict adds the tones `equivalent`, when configuration, plan and output agree and either the time gap is within noise or a capacity factor explains it, and `mixed`, when the wall clock and executor run-time or allocated core-hours move opposite ways; the title names where a time difference came from, so a smaller allocation is not read as a regression. Each metric row carries `withinNoise`, which never changes `direction`. New inputs: `--ignore-conf` and `--noise-band-pct` on the CLI, `ignoreConf` and `noiseBand` on `compare_runs`. The comparison page has a "What differs between the runs" card. Report schema 5 and metrics schema 1 are unchanged; every new field is additive.
- a92a85a: The verdict adds a cost lane beside its wall-clock steps and states the run's idle capacity. `verdict.costSteps` ranks findings by the measured busy core time a fix removes (`impactEstimate.coreTimeMs`), including findings with no wall-clock claim; a finding with no core-time figure is in neither lane. `verdict.idle` (`{ coreHours, allocatedCoreHours, pct, text }`) reads, for example, "14.8 core-h (22%) of the allocation ran no task." The dashboard labels the two lanes "By wall clock" and "By core time". The report schema stays 5; the fields are additive.
  
  The stage-shape `taskStageSkew` idle figure is a modeled upper bound that assumes every executor stays allocated through the straggler tail. It is now labeled `modeled` and clipped to the run's idle core time, so one stage never reports more idle capacity than the whole run.
- 0ea9fbd: Run comparison matches findings across runs by identity instead of tallying them by rule and impact band. A finding is the same finding in both runs when it has the same type, rule and location (a paired stage, a paired SQL execution, an audited setting, or the whole run), whatever its value or impact band. A finding that moves between bands, such as critical to warning, is no longer reported as one resolved plus one introduced, so `--fail-on-introduced` and the comparison verdict no longer treat an improved run as worse.
  
  Output changes in the CLI `comparison` block, the MCP `compare_runs` result (including its deprecated `findingsDelta` alias) and the dashboard:
  
  - `findings.changed` is new: one row per rule and band move, `{ rule, type, baseImpactBand, candImpactBand, count, stages }`.
  - `findings.introduced` and `findings.resolved` rows now hold only findings with no counterpart in the other run. An introduced row has `baseCount` 0 and a resolved row has `candCount` 0; a rule with more findings in the candidate no longer reads `1 -> 2`.
  - A finding that moves to a stage or SQL execution that pairs with a different one reads as resolved plus introduced.
  - The `--fail-on-introduced` budget and the MCP `evaluate_budgets` `failOnIntroduced` budget read the same diff, so a re-banded finding no longer violates them. A finding whose band worsens to exactly the gated band still counts for the budget (never under `all`), and the comparison verdict reads "More severe in the candidate" for a worsened one. A finding that improves never fails the budget.
  - A finding on a stage or SQL execution the aligner leaves unpaired matches the same rule's finding on an unpaired location in the other run.
  - The Markdown comparison report has a `### Changed findings` section.
  - The dashboard comparison page lists band moves under "Impact changed in candidate".
- 1ed4c88: Cost-only estimates no longer read as run time. A cost-only (`resourceOnly`) figure that sums task time is printed as core time with its certainty, for example "0.2 core-h of task time (modeled)", on the dashboard, the Markdown report and the JSON rows. `rawWaste` keeps its value and unit, and `coreTimeMs` stays in milliseconds.
  
  `impactEstimate.assumptions` names what an estimate's model assumes and leaves out, for example "assumes 200 MB/s per executor over 75 executors; counts disk spill only, not memory spill, serialization or GC", and each finding row carries `estimateProvenance`, the provenance sentence with those assumptions. `cachingOpportunity` reports the input its queries scanned (`rawWaste` in `bytes`, with `reread: true`) and how many queries scanned it, not a time. A `slowHost` task-time finding on one executor states `confidence: low`, a `validationRequired` sentence on how often the largest of N executors reaches the ratio by chance, and `executorCount` and `taskCount`. The report schema stays 5 and the metrics schema stays 1; the fields are additive, and finding ids and bands do not change.
- 7e3789d: A new `pythonUdf` finding (tag `PLAN`) flags stages that run row-at-a-time Python UDFs (`BatchEvalPython`). It reports the bytes sent to and returned from the Python workers, read from Spark's executor-side SQL metrics, and the time of the stages that ran them, and suggests Arrow-optimized Python UDFs (`spark.sql.execution.pythonUDF.arrow.enabled`, Spark 3.4 and later) or a pandas UDF. `ArrowEvalPython` is never flagged. The finding is informational and fires only when the stages sent at least 64 MiB and ran for at least 30 seconds together; both floors (`minBytesSent`, `minStageMs`) can be tuned with `--thresholds`. The thresholds are conservative guesses, not tuned against real workloads.
- eed36cf: Attribute a slow task tail to its cause. Each stage's tail (non-failed tasks over 3x the median task) is attributed from per-task input and shuffle-read bytes and records, GC time, shuffle fetch wait, CPU time and host. `skew` now fires on a tail whose extra time follows data volume, and `straggler` fires on the rest with the cause named (GC, shuffle fetch wait, one slow host, or unexplained with CPU use), so one tail is no longer reported by both. With no data volume to compare, the part of the tail that data, GC, fetch wait and host do not explain is `unattributed` when it is the largest share, and both detectors keep the duration-only behaviour for it, as for a stage with no tail attribution. New evidence fields: `cause` and `dataRatio` on `skew`; `cause`, `causeSharePct`, `host`, `hostTasks` and `cpuPct` on `straggler`. New `skew` threshold `dataShareMin`; `straggler` judges a tail with `skew`'s `ratioWarn`, `minTasksForP95`, `dataShareMin` and `floorPctWarn`, so tuning `skew` alone never leaves a tail reported by neither.
- 4e3e32b: The missed broadcast join finding (`underBroadcast`) compares the real shuffle `data size` of a join side, the metric adaptive execution uses at runtime, against the threshold the query ran with: `spark.sql.adaptive.autoBroadcastJoinThreshold` when the plan is adaptive and the property is set, else `spark.sql.autoBroadcastJoinThreshold`, with per-query overrides applied. Runs that carried this finding can lose it, so a CI gate or baseline that counted it moves.
  
  - It only names a side the join type can build a broadcast from: the right side for inner, cross, left outer, left semi, left anti and existence joins, the left side for inner, cross and right outer joins, and neither side of a full outer join. The finding carries `joinType` and `buildSide`; a join whose only buildable side is larger than the other side is skipped, since broadcasting it saves nothing.
  - Both join sides need a shuffle size of their own. A side that is not a shuffle of its own (another join's output, an aggregate, a reused exchange) is not summed from the shuffles beneath it, and its join is skipped, so `largerSideBytes` is always present.
  - A smaller side under 1 MiB is skipped (new `broadcastSizing.minSmallerSideBytes` threshold), and the 5 GiB tier is gone: no side above `overBroadcastBytes` (1 GiB) is suggested, so it no longer contradicts the oversized broadcast finding. Breaking for custom thresholds files: `broadcastSizing.broadcastTiers` now has 3 entries and `comparisonTiers` 2, so a file that sets either must drop its largest tier or it is rejected.
  - A side at or under the effective threshold fires as `notLimiting` whatever the other side's size, and the advice names the property that governs it.
  - The oversized broadcast finding (`overBroadcast`) also checks `spark.sql.adaptive.autoBroadcastJoinThreshold` under adaptive execution: it blames a `broadcast()` hint only when every applicable threshold is below the broadcast, reports auto-broadcast disabled only when all are, and otherwise names the property that admitted it.

### Patch Changes

- 7ea5b70: `diagnose_run` and `compare_runs` name the Spark application and the build that wrote the output: `app` and `generator` on a diagnosis, `baselineApp`, `candidateApp` and `generator` on a comparison. The CLI JSON carries `app` too, and `generator` in its `comparison`. The MCP server reports its package version in the handshake instead of a fixed `1.0.0`. Each findings row of a comparison has `stageLabels`, its stage names with the directories of call-site paths (YARN container directories, home directories, user names) removed. Each row of `stagePairs` has `stageLabel`, the same label for the pair's baseline stage. `stages` and the other raw stage names are unchanged and still carry the path, and `--redact` does not remove it, so show `stageLabel` and `stageLabels`. The verdict's finding count says it leaves out notes on an incomplete log or on data the log lacked. The tool descriptions say `runId` differs per tool by design. Report schema 5 and metrics schema 1 are unchanged: fields are only added.
- 8f7f6d0: Skew, straggler and partition-skew findings on a stage that runs a sort-merge or shuffled-hash join now say why AQE skew-join handling did or did not act, instead of "AQE skew-join handling is already on, so salt the key". The case comes from the execution's final plan and its effective Spark conf, and is published as `evidence.aqeSkew`:
  
  - `split`: AQE split the skewed partition, so the remaining imbalance is not join skew.
  - `evenReads`: the stage's shuffle reads are even (the largest task read under twice the median), so the slow tail is not partition-size skew; no conf is suggested.
  - `belowThreshold`: the largest partition is clearly over the median but under `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` or not far enough over the median for `spark.sql.adaptive.skewJoin.skewedPartitionFactor`; the remediation lowers them for the query.
  - `planShape`: an aggregate, window or other operator sits between the join and its shuffle.
  - `userRepartition`: the shuffle under the join is a `repartition` or `rebalance` in the job.
  - `joinType`: the join type does not let AQE split the skewed side (full outer joins, or the right side of a left outer, left semi and left anti joins, or the left side of a right outer join).
  - `extraShuffle`: splitting would add a shuffle for the aggregate, window or join above; the remediation sets `spark.sql.adaptive.forceOptimizeSkewedJoin`, or is a `code` entry before Spark 3.3, which has no such property.
  - `notSplit`: the thresholds and plan allow it and the log does not say why it did not happen.
  
  `SortMergeJoin(skew=true)` and `ShuffledHashJoin(skew=true)` nodes now count as joins.
  
  In the dashboard's Findings table, a grouped row no longer shows a one-line fix when its findings have different ones, such as skew findings with different AQE cases.
- 1c9c274: Correct findings and advice that were wrong or contradicted each other, found by reviewing the recently merged detector work.
  
  - `--redact` keeps per-query settings (`modifiedConfigs` on a SQL execution) only for the Spark SQL tuning keys the findings read and replaces every other value (a path, a bucket, a host) with Spark's `*********(redacted)` placeholder. The `spark.redaction.string` lookup is removed: Spark's replacement text is a constant.
  - Partition-count advice follows what sized the stage. A stage outside any SQL execution is never read as AQE-coalesced. `spark.sql.adaptive.coalescePartitions.initialPartitionNum` replaces the property as the starting count when set, and a task count above the configured one is not blamed on the stage's own `repartition(n)` unless the plan holds one: the advice states the counts. While `parallelismFirst` is on, the advice sets it to `false` first and raises the advisory size after it. `parallelismFirst`, `spark.executor.memoryOverheadFactor` and `spark.executor.minMemoryOverhead` join the defaults table.
  - `coldStart` reads an unset `spark.dynamicAllocation.enabled` as off, as Spark and the idle-capacity finding do. Cold-start and churn runs that never set it no longer suggest executor-count properties.
  - Missed-broadcast text names the case: a side over a small effective threshold, or automatic broadcast disabled with `-1`. For an adaptive plan it names `spark.sql.adaptive.nonEmptyPartitionRatioForBroadcastJoin` instead of table statistics.
  - The missing executor heap peaks note names the cause (tasks shorter than the executor heartbeat report zeros) and suggests `spark.eventLog.logStageExecutorMetrics=true` while it is off. The driver's metric rows do not count as executor evidence, matching the heap-peak finding. The idle-memory waste model uses executor alive time instead of peak executors times the whole run.
  - AQE skew-join diagnosis no longer judges summed left and right reads as one side: `evenReads` and the factor part of `belowThreshold` need one side to shuffle next to nothing, and a tail attributed to data volume is never called even or cured. A join with no stage ids is tied to a stage only by its exchanges or by matching shuffle bytes, so a later aggregate stage does not get the join's diagnosis. One-sided joins are advised to join the hot key on its own and union, not to swap sides. Skew factors print two decimals.
  - Tail attribution takes ratios against the median or a floor of 1 MiB and 1,000 records, and with a median task that read nothing, GC and fetch wait claim their time before data does. A tail with no attributed cause is reported once, as a straggler with neutral wording and no key advice, instead of as both skew and straggler.
  - Advice to lower executor memory conflicts with advice to raise it on the same stage: a stage's low-GC note is dropped there, and a run-level heap or idle-memory finding keeps its figures but not the advice to lower, and names the stages that ask for more. The low-GC note returns when heap peaks exist but the executor memory is unknown, and is never given on a stage that failed or lost tasks.
  - Settings read through the effective Spark conf: dynamic-allocation bounds, `logBlockUpdates`, the memory overhead keys including Spark 4's `minMemoryOverhead`, container size, resources and the evidence ledger's stage-metrics switch.
  - Wording: an `unexplained` straggler tail that read far more data says so and keeps data advice when data is its largest share, a median task that read almost nothing prints no ratio, cartesian joins with a condition, the Python UDF Arrow opt-out, and the straggler share's threshold.
  - The landing page and the Dashboard no longer preload the plan-graph vendor chunk: the d3 modules recharts and xyflow share live in their own chunk. A post-build test pins the layout.
  - The MCP run cache notices a file growing inside a rolling event-log directory. A cached comparison is dropped if either run left the cache while it was built, and each call receives its own copy of the result.
- a275a49: Code comments describe current behavior only. Calibration data, detector source status, the redaction coverage notes and the plan graph layout notes now live in the contributor and user guides. No behavior change.
- 5d085d5: perf: the CLI starts faster. It reuses V8's compiled code for the core modules across runs (Node 22.1 and later), and building a run's clean-check threshold summaries no longer loads ICU. A small log analyzes about 25 percent faster end to end; output is unchanged.
- 4cc7075: A comparison where no stages pair now says why in one sentence and offers a "Pick a stage pair" chooser in the Stages compared card, so a baseline and a candidate stage can be opened side by side without scrolling to the pinned deltas. Re-planned and unmatched stage lists show stage names next to their ids.
- 2171e85: Declutter the dashboard. The verdict card owns the top three findings, each with one "Show evidence" control that expands in place, and the Findings tab lists the rest as "More findings (n)", or says there are none. The header pill shows the largest critical saving as a share of the run ("1 critical, 2% of run"). The Export menu is wide enough for its labels, with download icons, a visible separator and a checkmark column for Redact identifiers. The Job Timeline x-axis uses distinct clock labels, a run with one constant executor count shows a sentence instead of an empty plot, and collapsed reference cards share one height.
- f87e45f: perf: the dashboard appears about 250 ms sooner after a log finishes parsing. The dashboard and its widget chunks now load while the log parses, so opening a run no longer waits out React's 300 ms Suspense reveal delay on the "Loading dashboard" fallback. The rendered dashboard is unchanged.
- c773063: The dashboard stage filter now shows a SQL-scope finding whose only stage is the selected one, such as a small-files finding on stage 3, matching what Stage details lists for that stage.
- 61345f9: Raise the dashboard's text and control size floor. Text a reader needs is at least 12px (tag badges, the impact pill, table headers, chart category ticks, axis titles and legends, the verdict strip); only numeric chart tick labels stay at 10px. Short links and buttons, such as the chart Table and Copy actions, tag badge links, the critical-count button and the stage detail links, now have a hit area of at least 24px for mouse as well as touch, without growing their visible size.
- be4d5aa: Complete the docs home and brand. The docs home gains a Tuning Reference card to match the top nav, the docs header uses the app's pulse-line mark, and "Docs" in the home title takes the ink color at a lighter weight.
- 7379bdd: Executor memory findings are measured from the executor metrics every Spark 3+ event log records on each task end, not only from stage executor metrics (`spark.eventLog.logStageExecutorMetrics`, off by default). Finding counts and the `memoryUtilization` shapes change, so a saved baseline, budget or ranking built on them needs refreshing.
  
  - `memoryUtilization` reads a per-executor heap peak from task ends, taking the larger of that and any stage executor metrics peak, and ignores the driver and all-zero rows (local mode). Peaks are sampled at executor heartbeat, so the finding text calls them a lower bound. The "memory data unavailable" note now means the log has no non-zero peak (Spark before 3.0, local mode) and no longer suggests a logging switch.
  - Over-provisioning is judged once, on the executor with the highest heap peak, because `spark.executor.memory` is one setting for every executor. The `heapOverProvisioned` finding carries `executorCount` and `executorSeconds`, and its waste figure is the unused heap times the seconds the executors were alive. It replaces one finding per executor.
  - The `heapNearCapacity` finding is removed. `JVMHeapMemory` is heap used including uncollected garbage, so a peak near the heap limit is normal JVM behaviour and not evidence of memory pressure.
  - The low-GC "memory may be over-provisioned" note on `gc` is emitted only when the log has no measured heap peak. On the private logs it was the most frequent finding.
  - The `wasteModel` variant divides summed task run time by the cores per executor before comparing it with executor-seconds, and is skipped when the cores are unknown. Used memory was overstated by the core count, so the finding now fires on more runs.
  - Parsing: `Task Executor Metrics` is read from every task end into `runAggregates.executorPeakMetrics`.
- 1804170: perf: the plan graph view reuses a graph's node positions when only the node data changes. Switching the duration attribution, or returning to a node filter or scope already shown, no longer runs the layout again; on a plan of about 1,100 operators the duration switch drops from about 1 second to under 150 ms. The first open of a graph takes the same time, and the layout is unchanged.
- a53d611: perf: the plan graph view lays out large plans (200 or more operators) in a Web Worker, so the page keeps responding while the layout runs. On a plan of about 2,000 operators opened in full, the longest main-thread task drops from about 1.5 s to about 0.6 s. The layout is unchanged, and the view falls back to the main thread when a worker cannot start.
- 7382772: Chart legend labels use the normal text color instead of the series color, and docs-site code-block comments use the muted text color, so both meet 4.5:1 contrast in the light and dark themes.
- ab28fcc: Comparing two runs normalizes each plan node's detail, name and attribute names once instead of once per stage that ran part of the node, which takes about 15% off the comparison step on large logs. The comparison output is unchanged.
- 6d0e89d: A new `nestedLoopJoin` plan finding flags a `BroadcastNestedLoopJoin` or `CartesianProduct` whose output rows explode. Spark plans these when a join has no equi-join key, and they compare every left row with every right row. The finding fires when the join's executor-side `number of output rows` is at least 1,000,000 and, for a `BroadcastNestedLoopJoin`, at least 10 times its larger input; a `CartesianProduct` re-reads each input once per partition of the other side, so it is judged on its output alone. It carries the join type and condition, the output and input row counts, and an impact graded by the time of the stages that run the join. The advice is to add an equi-join key, to bucket the range of a range join, or to confirm that a cross join is intended. A join with no reported row counts is not flagged. The public corpus has no nested-loop join, so its findings do not change.
- ad31932: The plan graph no longer goes blank on a large plan whose segments interleave, such as the Advanced filter on a plan of over a thousand operators. Dagre could drop three overlapping segment groups from its ordering pass and place two nodes on one slot, which made the layout throw. The layout now orders again with the groups in one fixed order when that happens, and plans that laid out before keep their positions.
  
  A large plan's layout now shows a centered progress bar with the message "Laying out plan graph…", and the graph view fits the plan to the view when it first opens, as the Fit to view button does.
- be366f2: On a phone-width screen, opening a plan graph node shows its detail as a bottom sheet about 40 percent of the screen tall, with a grabber you can swipe down to dismiss, instead of a side panel that covered the whole graph. The graph pans to keep the selected node visible above the sheet, and the legend and minimap step aside while it is open. Escape and the close button still close it. At 640 px and wider the detail stays docked beside the graph.
- 90645bd: The plan graph opens at a readable zoom: the fit never drops below the zoom that renders the smallest node text at 11 px, and a plan too large for the canvas scrolls instead of shrinking. The layout stays one right-to-left flow on desktop, so a long chain scrolls sideways, and stacks vertically on a phone-width viewport. The legend starts collapsed, and the minimap appears only when part of the graph is off screen unless the rail toggle forces it on or off.
- 1036640: Finish the size floor. The landing's "Where do I find my event log?" disclosure is 32px tall (44px on phones) and its whole row is clickable, and "Choose file" and "Try a sample run" are 44px tall on phones. In the docs, footnote markers and heading permalinks have a 24px hit area without changing their look. The disabled "Pin pair" button now says "Pick one stage from each run", and the plan node "Plan detail" text is 12px.
- a400798: fix: the skipped-lines count now follows the run you open. Drilling into a compared run or switching back to a recent file shows that run's count in the top bar badge and the HTML export, instead of zero or the previous run's value.
- 4a09919: The bundled sample run is a corpus log with 13 distinct finding types, including shuffle, spill, slow-host and speculation findings, so **Try a sample run** shows more of what the dashboard detects.
- 9d62522: A task-time `slowHost` finding (`evidence.dimension` `taskTime`) now needs an executor whose mean task duration is further above the median executor's than the stage's own spread of task durations and the executor's task count allow. Before, the ratio of the largest executor mean to the median was enough, so the slowest of 75 executors reached the top of the ratio by chance far more often than the slowest of 3, and its claim as a share of the run could then rate it `critical`.
  
  - The test is a z-score on the log scale of task duration: the executor's mean log duration minus the median executor's, over the stage's task spread divided by the square root of the executor's task count. It must reach `sqrt(2 ln(executors / (2 * outlierAlpha)))`, so the cutoff grows with the number of executors. The new tunable threshold `slowHost.outlierAlpha` defaults to 0.005, which is 3.4 for 3 executors and 4.2 for 75. The ratio tiers, the 1000 ms floor and the byte dimensions are unchanged, and `ratioTiers[2]` is still not read.
  - Plugin-visible band change: a task-time `slowHost` finding that a chance gap produced is gone, so a run can lose a `critical` (or `warning`, or `info`) `slowHost` finding it had before. A finding for an executor that is slow against the stage's spread keeps its band, which still comes from its wall-clock claim. On the public corpus the one affected finding is the `critical` task-time `slowHost` on a 1.2 s claim in `pairwise-07`.
  - Finding ids, types, fields and matching are unchanged, and report schema 5 and metrics schema 1 stay. The `slowHost` detector is at version 2. Each `executorStats` row of a stage record carries two new additive fields, `logDurationSum` and `logDurationM2`. A stage recorded without them, or with a non-finite value in either, flags no executor on task time.
- 54f859b: Detectors judge each run against the Spark configuration that applied to it. Findings that cite or suggest a setting change wording or remediation on runs where the effective value differs from the old assumption.
  
  - Defaults come from Spark's own sources by version for every property a detector reads or suggests, instead of four hard-coded keys. A Spark 4.0 or later run now uses a speculation multiplier of 3 and quantile of 0.9, where earlier releases use 1.5 and 0.75.
  - A finding scoped to one SQL execution (`skew`, `straggler`, `shuffle`, `partitionSizing`, `underBroadcast`, `overBroadcast`) reads that execution's settings from `SQLExecutionStart.modifiedConfigs`, so a job that sets `spark.sql.shuffle.partitions`, the broadcast threshold or the AQE switches with `spark.conf.set` is judged against what it set. A remediation the query already applied is left out.
  - `speculationWaste`, `slowHost` and speculative-attempt `straggler` recommendations name the run's effective speculation trigger, for example "a task running over 3x the median is relaunched once 90% of the stage's tasks have finished".

## 0.29.1

### Patch Changes

- 43a5e93: The configuration audit drops the findings that contradict how Spark behaves, and reads the overhead settings a run sets. Runs that carried these findings lose them, so a CI gate or baseline that counted them moves.
  
  - The shuffle-service warning is gone. Spark refuses to start dynamic allocation without the external shuffle service unless shuffle tracking, shuffle-block decommissioning or a reliable shuffle storage plugin is on, and shuffle tracking defaults to on from Spark 3.4, so a logged run with dynamic allocation on and the service off always had one of them and its shuffle data was not at risk.
  - The `minExecutors` above `maxExecutors` finding is gone. Spark throws on that pair at startup, so no run that wrote an event log has it. The unbounded `maxExecutors` note stays.
  - The Kryo serializer note appears only on a run with at least one stage outside a SQL execution. DataFrame and SQL shuffles and caches use Spark's own row format, so `spark.serializer` does not apply to them. `auditConfig` takes the run's stages as a second argument; without them the note stays silent.
  - The low `memoryOverhead` check compares against the default Spark would compute from the run's own `spark.executor.memoryOverheadFactor` (Spark 3.3 and later) and `spark.executor.minMemoryOverhead` (Spark 4.0 and later), falling back to 10% and 384 MiB, instead of always using those two values.
- 9b80793: Plan operators now carry the SQL metric values that executors report, the figures Spark's SQL tab shows. They are read from the accumulables of each `SparkListenerStageCompleted` event, where a plan metric's value is its running total, so a later stage replaces an earlier one's value. A value from the driver's own accumulator updates still wins when both exist. Exchange `data size`, operator `peak memory`, `spill size`, `number of output rows` on joins and scans, `data sent to Python workers` and the operator timing metrics resolve to real values; `average` metrics are left out, because their total is not the average the SQL tab computes.
  
  - `underBroadcast` compares Exchange data sizes that are now populated, so it fires on sort-merge joins with a small side where it previously saw `0 KB` on both. Its logic is unchanged. The corpus gains 29 `underBroadcast` findings, all `info` band.
  - Plan-shape fingerprints skip executor-side metrics, so `duplicatePlanSubtree` and `cachingOpportunity` ids are unchanged.
  - The plan view shows the new values, and its per-operator time attribution weights operators by their timing metrics where it used to split stage time evenly.
- 60be47d: Stop the landing page from preloading the charts and plan-graph vendor chunks. React and its runtime modules are now emitted in `react-vendor` instead of inside those two chunks, so the entry chunk no longer imports from them and they load only with the views that use them.
- 73b5807: Run reports and run comparisons compute a stage's plan-derived identity once instead of once per stage. The SQL plan tree is indexed by stage id once per execution, and a stage with no attributed plan node reuses a cached whole-tree identity. On a 3.5 GB log the report's metrics step drops from about 0.56 s to about 0.10 s, a comparison of two 566 MB logs from about 0.98 s to about 0.25 s, and comparing runs in the dashboard no longer blocks the main thread for a second. The analysis output is unchanged.

## 0.29.0

### Minor Changes

- df6f96a: The dashboard has a new light and dark palette: a gray canvas with white panels in light, slate instead of near-black in dark, and an indigo accent in place of orange. Status colors now mark analysis status only, and neutral chart series use their own colors. The UI font is now Instrument Sans with JetBrains Mono for numbers and code. Both fonts ship with the app and are embedded in HTML exports, so no page requests a font from a third-party server.
  
  The board keeps its layout. The verdict now shows the run's longest stages on a run clock, with the stage to fix first marked by its step code (F1, F2, F3). The same code appears on that finding's row and in the stage table. Tags are small square chips, metric tiles have gauges, and report widgets share one card style. The landing page, the run comparison page and the HTML export use the same look.

### Patch Changes

- 11e116a: `writeTargets` names the table of a Delta `MERGE`, `UPDATE` or `DELETE` when its plans print the same local table as both `file:/path` and `file:///path`. The two spellings are one path, so the write reports `file:///path` instead of a `null` target.
- b3e3520: The per-finding detection reference files served by the MCP `get_finding_documentation` tool are generated from the user guide at build, test and pack time instead of being committed. Published tarballs contain the same files.
- 3f1e7bd: Idle-capacity figures and the low-parallelism partition estimate change values, and the report gains one field. The report's schema version is unchanged. Existing numbers move, so a saved baseline, a budget or a ranking built on them needs refreshing.
  
  - Idle capacity is measured against the run's allocation, the cores times the time each executor was alive that `metrics.allocation.coreHours` reports, instead of peak concurrent cores times the whole run. The peak basis counts cores a dynamic-allocation or late-joining run never held, so the idle figure could exceed the allocation. The `utilization` percentage and its `cpuUtilizationPct`, the `utilization` finding's idle `rawWaste`, `memoryUtilization`'s `idleCores` rate, the dashboard's Unused core time and the verdict's idle share all use it, and the Scorecard's driver and executor split counts the cores held inside and outside the stages' windows from the same executor alive intervals. Utilization rises on runs whose executors came and went, so such a run can clear the 60% utilization threshold or fall under the 50% idle-cores one, and its `utilization` and `idleCores` findings disappear. Across the corpus logs, 26 of these findings disappear (10 `utilization`, 16 `idleCores`) and every remaining `utilization` idle figure is smaller.
  - `impactEstimate.idleCoreTimeMs`, a `{ low, high }` range in core-milliseconds with `low` equal to `high`, gives the `utilization` finding's idle capacity as allocated minus busy core time, never below zero and never above the allocation. It is separate from `coreTimeMs`, which stays null for idle findings because it counts busy task time a fix removes. `idleCores` is the memory view of the same condition and carries none, so consumers rank on one idle figure. The `idleCores` memory figure (`mbSeconds`) is the idle rate times the run's allocated memory-seconds, with Spark's default heap and overhead where the memory properties are not logged. The 12 corpus `idleCores` findings that had no figure now report one, and some memory figures are larger.
  - Idle findings gain remediation. With dynamic allocation off or unset, `set spark.dynamicAllocation.enabled` and `decrease spark.executor.instances` are alternatives, and the recommendation reads "either ... or": apply one. With it on, `decrease spark.dynamicAllocation.maxExecutors`, plus `decrease spark.dynamicAllocation.minExecutors` when the logged floor is above 0, where `remediation` was empty. `remediation` entries apply together unless the recommendation words them as alternatives. The recommendation text names these properties. `spark.dynamicAllocation.executorIdleTimeout` is not suggested, because `autoscalingChurn` recommends raising it.
  - `partitionSizing`'s `lowShuffleParallelism` wall-clock estimate no longer collapses to near zero on a stage whose few long tasks fill its duration. The fix splits those tasks, so the claim is the longest task's own reduction, `taskDurationMax − taskDurationMax × taskCount / targetTaskCount` (the longest task after an even split), instead of scaling the whole stage duration. It is a modeled figure, and `coreTimeMs` stays null: it is stage wall-clock, ranked on `wallClock`. `shufflePartitionSkew` and `maxPartitionTooBig` are unchanged.

## 0.28.0

### Minor Changes

- 2a7acea: Skew remediation now fits the stage and the run's effective conf, and every median is the textbook median.
  
  **Median.** The P50 of task duration, shuffle read and spill (`taskDurationP50`, `shuffleReadP50`, `spillMemP50`, `spillDiskP50`) is the mean of the two middle values on an even task count; it was the lower middle value. The slow-host mean-duration median and the executor max/median ratio took the upper middle value and now use the same median. P95 and max are unchanged. A bimodal stage with six tasks of 137, 219, 257, 28345, 34157 and 44374 ms now reports max/median 3.1 instead of 172.7, so such stages no longer lead the findings by an inflated ratio, and some skew, straggler and stage-shape findings that only cleared their threshold on the lower median no longer fire.
  
  **Effective conf.** A conf a finding would set is left out when its effective value already matches: the logged property, else Spark's default for the run's `sparkVersion`. Modeled defaults are `spark.sql.adaptive.enabled` (on from Spark 3.2) and `spark.sql.adaptive.skewJoin.enabled` (on from 3.0). On Spark 3.5 with AQE on, skew findings no longer suggest `spark.sql.adaptive.skewJoin.enabled`; on Spark 3.0 and 3.1 with AQE unlogged they suggest `spark.sql.adaptive.enabled`.
  
  **Stage shape.** Skew-join handling is suggested only for a stage that reads a shuffle in a SQL execution whose plan has a sort-merge or shuffled-hash join. Skew findings and `shufflePartitionSkew` gain `evidence.origin` (`shuffleJoin`, `inputScan` or `other`). A scan stage with uneven input gets a `spark.sql.files.maxPartitionBytes` decrease and file-size advice, and any other stage gets the salting advice with no conf. `stageSlowness` gains `evidence.reads` (`shuffle`, `input` or `other`) and suggests `spark.sql.shuffle.partitions` and `spark.default.parallelism` only for a stage that reads a shuffle; a scan stage gets the `maxPartitionBytes` decrease instead.
  
  **Other finding types.** The same three checks now apply wherever a finding carries a conf or a median:
  
  - `spill` and `tinyTask` suggest `spark.sql.shuffle.partitions` only for a stage that reads a shuffle, and carry `evidence.reads`.
  - `shuffle` and `partitionSizing` (`lowShuffleParallelism`) read the effective `spark.sql.shuffle.partitions` (logged, else Spark's 200), and carry `evidence.partitions`: `raise`, `sufficient` (tasks already a good size), `aqeCoalesced` (AQE merged the partitions, so `spark.sql.adaptive.advisoryPartitionSizeInBytes` is the lever) or `ownPartitioning`. A shuffle finding with no partition-count problem now has an empty `remediation`.
  - `autoscalingChurn` and `coldStart` suggest no dynamic-allocation property when the run turns it off, and carry `evidence.dynamicAllocation`.
  - `straggler` words its skew advice from the stage as a skew finding does, carries the matching `remediation` and `evidence.origin`.
  - `underBroadcast` and `overBroadcast` compare against the effective `spark.sql.autoBroadcastJoinThreshold` (logged, else 10 MiB, `-1` disabled) and carry `evidence.broadcastThreshold`; a threshold that already admits the smaller side, or is already below the broadcast, is not suggested.
  - A skew finding on Spark before 3.0 suggests no AQE conf.
  - Effective defaults modeled: `spark.sql.shuffle.partitions` (200), `spark.sql.autoBroadcastJoinThreshold` (10 MiB), `spark.sql.adaptive.coalescePartitions.enabled` (on from 3.0), besides the AQE keys above.
- 7db426c: The dashboard comparison page now shows a **Stages compared** table, and comparisons can be gated per paired stage.
  
  The table lists each pair from `stagePairs` with its change in run time, CPU time, spill, input, output and shuffle, sorted by the absolute run-time change, with the pair's `quality` and `score`. Re-planned groups and unmatched stages are listed below it, and selecting a stage shows both runs' figures for it side by side inside the comparison, with links to open it in either run's dashboard. The comparison page is about 30% wider, and the Metrics columns read Baseline and Candidate with the full run name on hover.
  
  New budget `max-stage-regression`: `--stage-regression-budget <metric>:<pct>` (repeatable, needs `--baseline`) on the CLI and `stageRegressionBudgets` on MCP `evaluate_budgets` fail when any paired stage's `executorRunTime`, `executorCpuTime`, `memoryBytesSpilled`, `diskBytesSpilled`, `shuffleReadBytes` or `shuffleWriteBytes` grew by more than the percentage. By default only `exact` and `structural` pairs count; `--stage-quality` and `stageQualities` choose the qualities. It is inconclusive when no eligible stage pairs. `inputBytes` and `outputBytes` are refused (usage error on the CLI, call error on MCP) because volume has no regression direction. Existing budgets and exit codes are unchanged, and `confidence` still does not affect any budget.
- e740c9a: Stages now pair in two levels, and the stages a re-plan leaves over are reported as `replanned` instead of `unmatched`.
  
  SQL executions of the two runs align first, in submission order, scored on call site, description and plan structure. Then the stages inside each aligned pair of executions pair as `exact` (same normalized name and plan text), `structural` (same plan shape and sorted attribute names, with literals, paths, file counts and ids left out) or `aligned` (similar text, or no plan to compare and paired by position among stages of one name). A loop that ran 14 times in one run and 15 in the other pairs 14 iterations, a self-join subtree counted 3 times against 2 pairs 2, and a grouping set emitted in another column order each run pairs structurally. The `structural` and `aligned` qualities were reserved values before; `score` is 1 for `exact`, the text similarity for the other two, and 0.5 for a pair made by position.
  
  When an aligned execution pair has different stage counts (a broadcast join took out an exchange) and stages are left over, they are reported once in `replanned`: `baseExecutionId`, `candExecutionId`, `baseStageIds`, `candStageIds` and `deltas` (the total of each delta metric per side). Leftovers under equal stage counts stay `unmatched`.
  
  **Behaviour change: `runtimeCoverage` and `confidence` count replanned run time.** `runtimeCoverage` is the share of both runs' executor run time in paired and replanned stages, so a conf change that re-plans a join can report `ok`. `replanned` carries the totals so a caller can see how much run time that is. Runs whose SQL executions share too little work to be one job (fewer than half of the smaller run's executions pair) get no stage pairs at all, so a comparison of two different jobs reports `low` instead of pairing generic stages such as a lone `count`.
  
  New field `executionAlignment` in the comparison block (`baseExecutions`, `candExecutions`, `pairedExecutions`, `agreement`, `accepted`, `bounded`), in the CLI's `comparison` object, MCP `compare_runs` and the dashboard's result. The execution alignment runs in full up to 1,000,000 execution pairs and in a band around the diagonal above that; `bounded` says which. `comparisonSchemaVersion` stays 1: the change is additive.

## 0.27.0

### Minor Changes

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

### Patch Changes

- 64a90a4: Update dependencies to their latest minor and patch releases, including `@modelcontextprotocol/sdk` 1.32, and pick up transitive security fixes from `npm audit fix`.
- fef239a: Split the largest user-guide and contributor-guide pages into one page per topic, and point in-code doc references at the new locations.

## 0.26.1

### Patch Changes

- 856de0b: Run comparisons name the two runs Baseline and Candidate everywhere, matching the CLI's `--baseline` flag, instead of Run A and Run B. The compare slots read **Baseline** and **Candidate**, the verdict says "The candidate finished 9.9s faster than the baseline (37%)" or "The candidate had 2 of 5 jobs fail (baseline: none)", the buttons read **See where to start in the candidate**, **View baseline dashboard** and **View candidate dashboard**, and a load error starts "Baseline:" or "Candidate:". The verdict drops its "Run A is the baseline and run B the candidate." opener. The CLI's Markdown comparison and MCP `compare_runs` carry the same verdict text. MCP's Markdown names the runs as "Baseline: <run id> · Candidate: <run id>", and the CLI's, whose runs have no other name, opens with the verdict. MCP's `runIdA`/`sourceA` and `runIdB`/`sourceB` parameters keep their names.
- 18ca1d5: Machine-readable run metrics and effective Spark conf in the CLI's JSON output, for tools that tune a job without reading a report.
  
  - `metrics` block beside the report (inside `candidate` with `--baseline`, and in each NDJSON line's `candidate` with several candidates), with its own `schemaVersion`. Run totals for time, data, shape (failed stage attempts and resubmitted stages, apart from task retries) and allocation (allocated core-hours and memory GB-hours from the executor lifecycle), `runComplete`, the share of task run time spent in Python stages, and per-stage rows keyed by the stage fingerprint the run comparison uses. A figure the log cannot provide is `null`, never `0`.
  - `effectiveConf` block with the run's Spark properties. Values are withheld when the key or value matches Spark's default secret pattern, the job's own `spark.redaction.regex`, or `--conf-redact-regex`; credentials in URL-like values (userinfo, Oracle `user/password@`, `pwd=`, `sig=`) are stripped. `--conf-keys` narrows it to named properties. Under `--redact` both blocks use the report's host and app pseudonyms.
  - `executorCpuTime` and `allocatedCoreHours` join the comparison metrics, lower is better, so `--regression-metric` accepts them and the dashboard's run comparison shows them.
  - A stage running a Python UDF in SQL (`BatchEvalPython`, `ArrowEvalPython` and the other Python operators in its plan) now counts as a Python stage, as a `PythonRDD` stage already did. The "tasks mostly idle" check uses the same test, so the stage-slowness estimate no longer treats these stages as idle and drops its zero-waste claim for them. A few previously suppressed claims on such stages now show.
  - The parser records each stage's rows written (`outputRecords`) and counts its attempts across resubmits (`stageAttempts`, `failedStageAttempts`), keeping the work of replaced attempts in `earlierAttempts`, and of a failed attempt's tasks that end after it, in `lateAttemptWork`, for the metrics block. A stage's own figures stay the latest attempt's. `ArrowAggregatePython` and `ArrowWindowPython` (Spark 4.1) count as Python operators.
  
  - Run and per-stage CPU and run time now include every task attempt: failed attempts a retry replaced and speculative copies that lost, so a candidate that causes OOM retries does not look cheaper. The stage figures the detectors and dashboard read are unchanged.
  - Memory GB-hours now use the container size Spark requests: executor memory (1g when unset), overhead (including the legacy `spark.yarn.executor.memoryOverhead` and `spark.executor.memoryOverheadFactor`), off-heap size when enabled, and `spark.executor.pyspark.memory`.
  - The effective conf withholds more credential forms: Azure `fs.azure.account.key.*`, `apiKey`, `pwd`/`pass` keys, `sas`, `sig` and `credential` keys, and strips `Pwd=`, `pass=`, `apiKey=` and `AccountKey=` parameters from any value, not only URLs.
  - The run comparison (dashboard, CLI `--baseline`, MCP `compare_runs`) sums run time, CPU time, GC time, spill, I/O, task and failed-task counts over every task attempt, the same sums as the `metrics` block, so the two never disagree for one run. Its table notes this.
  - The utilization finding's `cpuUtilizationPct` is now null instead of 0% when the log recorded no CPU time.
  - The dashboard's Efficiency card, its Memory utilization card and the idle-cores finding text say "available" instead of "allocated" for peak concurrent cores times run time, so that figure no longer shares a name with the allocation figure, which sums each executor's lifetime.
- ac5300f: Small wording fixes so the same thing reads the same way everywhere.
  
  - Collapsed evidence cards count their findings in one form, "3 findings", instead of "3 issues flagged", "3 stages flagged", "1 item flagged" or "2 findings flagged".
  - Spill and Shuffle I/O suggest a shuffle partition count in one form: "Try spark.sql.shuffle.partitions = 1520 (now 200 tasks; target 128 MB per partition)".
  - Partition Sizing prints a stage's savings once per rule, not again above the rules, and a skewed partition over an empty median reads "far larger than the median, which is effectively empty".
  - Stage Shape's low-parallelism row reads "Low parallelism: 0.25 tasks per core".
  - Stage Summary shows "Scroll sideways to see all columns" only while the table is wider than its card.
  - A duration of an hour or more reads "5h 59m" instead of "359m 18s", on the board and in the CLI report.
  - Slow Executor Host rows and their findings name the metric in plain words, such as "Executor 3: 6.2× the median task time" and "Executor 3's shuffle read and write is 3× the median", instead of code names like shuffleBytes.
  - ETL Phase Attribution explains its summed phase times in one shorter sentence, and Evidence availability rows in Advanced view drop a summary that only restated the row's state, keeping the observed count.
- b4c618f: A link to a heading in the docs site or the Spark tuning reference now lands with the heading below the page's top navigation instead of behind it. The offset is measured from the navigation the reader sees, so it also holds on the published site, where the Shuffle Works product bar replaces the docs navbar and can wrap onto more than one row. A deep link into a tuning-reference page also stays on its heading after the page finishes loading. The landing page's "Spark optimization reference" card opens the reference's introduction page without jumping to a fragment.
- c5f5663: Every evidence card states its fix once. Slow Stage, Speculation Waste, Failed Tasks, Retry Waste, Memory Utilization, Partition Sizing, Autoscaling Churn, Job Failures, Config Audit, Excessive Small Files, Missed Broadcast Join and Oversized Broadcast Join print the fix at the top of the card, one line per kind of finding, the way the other evidence cards already do. Their rows keep what they measured: rows that had no measurement besides the detector's sentence show the measured part of it, and each Partition Sizing bullet pairs its partition figure with its estimate.
- ea89fdd: Evidence cards state each fix once. GC Pressure, Stragglers, Slow Executor Host, Spill, Executor Utilization, Failed Stages, Cold Start, Cache Storage, Caching Opportunities and Redundant Plan Subtree print the fix at the top of the card, one line per kind of finding it holds, and each row keeps only its measurement. Before, every row repeated its detector's recommendation, which restates the row's number and then gives the same fix as the row above. Core Usage by Locality follows its non-local share with the fix instead of the recommendation that restated the share. Cache Storage shows each finding's measured detail in Basic view too, and Caching Opportunities' Recommendation column becomes Estimate.
- c5f5663: An evidence link on the Findings tab switches to the Full app report tab and focuses its ledger entry every time it is clicked. After the first reveal, going back to Findings and clicking an evidence link again left the reader on Findings.
- 8b7a648: Findings, clean checks and the Advanced verdict say each fact once and give real numbers.
  
  - A cache finding names its RDD by the first 40 characters of the name, which is often a whole physical plan, and an unnamed RDD reads "RDD 7" instead of "RDD RDD 7". The Cache Storage card still shows the full name.
  - A Findings group of resource findings shows its total, such as "×2 · 2.6 GB-h", instead of "resource-cost projection", the total the CLI report already printed. A group of findings in one band shows "×2" instead of "2 info" under the Info heading. Task skew's and shuffle's fixes no longer end by restating their row label.
  - Clean-check captions state the detector's thresholds, such as "Stage shuffle read above 50 MiB." instead of "the configured minimum byte threshold", and a run tuned with `--thresholds` states its tuned numbers. The intro reads "Every check below passed. Each caption gives the threshold it was held to."
  - The Advanced verdict's estimate line no longer repeats the savings range beside it ("Estimate: Measured; the stage shared the cluster: 411ms is the floor, 1.3s if the fix fully lands."), and the order note reads "Order: highest potential savings first, unestimated last; impact band breaks ties."
  - Confidence caveats say what their floor means, such as "Warning needs at least 0.5% of run time at stake, critical 2%." for stragglers, instead of "our own noise floor for this metric". Skew, GC, core locality and duplicate plan subtree caveats change the same way.
  - The Incomplete Run card states the missing ApplicationEnd event once, in a shorter sentence, and a verdict led by idle capacity drops its summary sentence, since the title gives the idle share and the first step the fix.
  
  The CLI report and MCP tools carry the same recommendation, caveat, threshold and estimate text.
- 82a9052: `--redact` and the MCP `redact` option now replace a failed stage's failure reason with `[redacted]`, since Spark's message can carry file paths and data values that no host or app-id pattern catches. This covers the `stageFailed` finding's text, the stage's failure reason and a job's exception in the HTML export, and the report's `failureReason`. Shuffle I/O and the Skew, Stage Shape and Tiny Tasks cards now state their fix once above the rows, like every other finding card. The incomplete-log check's threshold summary names only the `ApplicationEnd` event it looks for.
- e11ff4f: Compute Efficiency and Wasted Core-Hours are one card. The two Full app report cards showed the same allocated core-hours and the same waste share, one calling the total "available" and the other "allocated". Compute Efficiency now says "Allocated", adds the used core-hours and the top stages by task core-time that Wasted Core-Hours held, and its closing line names the larger waste with its fix, such as "Most of it is driver waste: review spark.driver.memory and spark.driver.cores before scaling executors." The Scorecard's Basic view captions say the stage-running time once, beside the figure it feeds: Wall-clock reads "Total run time." and Efficiency "Share of the run with a stage running (26.0s). Higher is better."
- 8d4a529: Stage Shape's task/stage skew row reads "Task/stage skew: 87%" (the longest task's share of the stage's wall-clock) instead of the raw fraction "0.87". The inverted autoscaling bounds finding now splits into the bounds as its measurement ("spark.dynamicAllocation.minExecutors (5) exceeds maxExecutors (3)") and "set min ≤ max." as its fix, so the fix no longer repeats the bounds under "What to try". Four other recommendations (low parallelism, speculation waste, autoscaling churn and caching opportunities) now follow the same "measurement: fix" shape.
- c5f5663: A skew finding and a straggler finding on the same stage now carry the overlap note whichever way skew measured the stage. Both detectors claim the same replayed tail recovery, but the note appeared only when skew used its max/median ratio (stages under 20 tasks), so a P95/median skew finding beside a straggler finding showed two equal recoverable-time figures with nothing saying not to add them. The note now reads "both measure the same slow-task tail".
- 7fe40c7: Evidence report finding rows gain two machine-readable fields. `remediation` lists the Spark property changes a finding's recommendation names (`{kind: "conf", key, direction, suggested}`), with `suggested` set only where the detector computes a value (for example the shuffle partition count that brings partitions to 128 MiB) and `null` otherwise. `impactEstimate.coreTimeMs` gives the busy core time a fix removes in core-milliseconds next to the wall-clock range, only where the detector measures it (GC time, retried or discarded speculative attempts, the task time a skew or straggler fix removes). It is `null`, never 0, for a finding with only a wall-clock claim, for figures modeled on an assumed constant (core locality's fetch penalty, autoscaling churn, job failures), and for findings whose waste is idle allocated capacity (utilization, idle cores), which keep their idle figure in `rawWaste` with `idle: true`. A stage's slow tail is counted once across skew and straggler. Idle core figures now read "of idle core capacity" instead of "of core time" on the dashboard, HTML export, CLI and MCP. A remediation that sets a property to a fixed value is left out when the run's logged conf already has that value, and the recommendation, including the dashboard's one-line fix for a group of findings, then points at the remaining remedy instead of that property; Spark's unlogged defaults are not modeled. When the logged shuffle partition count is already at or above what a low-parallelism stage needs, its recommendation points at the stage's own partitioning and suggests no property, and dynamic allocation suggestions are dropped when the run has it off. The report's schema version is unchanged. The core locality recommendation no longer names `spark.locality.wait`, which it gave no direction for. The autoscaling churn finding also lists the dynamic allocation min and max executor bounds its text names.
- ea6e2a4: Unused core time now counts executor capacity as the most cores alive at once, the count the idle-capacity findings already use. It used to add up every executor the run ever added, so on a run that replaced executors (spot preemption, dynamic allocation) the Scorecard tile read higher than the verdict's idle figure: 88% beside 75% on a run that swapped one executor for another midway. The same capacity now feeds Compute Efficiency, Wasted Core-Hours, the report's `runShape.unusedCoreTimePct` and the `--min-efficiency` budget, so those figures drop on such runs and a budget that failed on the old count can pass. Runs whose executors never left are unchanged. The tile's Basic view caption now says what it measures instead of explaining a gap that no longer exists.
- d3a74d7: Fixes found by checking the user guide against the code.
  
  - The Stage Shape card's task-to-stage rule (`SHAPE`) now fires when the longest task runs for more than half its stage's wall-clock and over 3× the median task, on a stage that takes at least 0.5% of the run. It compared the longest task against 3× the stage's wall-clock, which a task inside its stage can't reach, so it never fired. Its value is now that share of the stage, such as 0.99, and the `stageShape` detector reports version 2 with two new tunable thresholds, `stageShareMin` and `taskStageSkewFloorPct`; `skewWarn` is now the ratio to the median task.
  - In MCP, a local file or folder that isn't a decodable event log reports `invalid-event-log`, the code a History Server archive that fails to decode already reported, instead of `access-or-upstream-failure`. `list_runs` reports `upstream-unreachable` when the History Server refuses the connection or times out, as `diagnose_run` does.
  - Redaction replaces the app name with the app id's pseudonym everywhere: `diagnose_run`, `get_run_summary`, the CLI's `--redact` report and HTML export, and the dashboard's **Redact identifiers** export, as `list_runs` already did. `spark.app.name` in the exported config is replaced too.
  - The run comparison labels its whole-run `memoryBytesSpilled` total "Memory spill" instead of "Shuffle spill". The `shuffleSpill` key is unchanged.
  - The `sparkforensics-server` `/mcp` endpoint is documented in the MCP tools guide and in `--help`.
- ef79364: The verdict explains step grouping once. Its summary now reads "Findings on one stage are grouped, and their savings overlap.", and a grouped step says "Also flagged here, likely the same cause:" before the other findings' names instead of repeating why they were grouped. The CLI's Markdown report uses the same line. Each verdict step and each finding in the stage details dialog shows the finding's own measurement under "What's happening" and only the fix under "What to try". Before, "What's happening" gave the tag's general definition, the same text for every finding of that tag, and "What to try" repeated the measurement ahead of the fix. A recommendation with no measurement shows only "What to try".

## 0.26.0

### Minor Changes

- d7ea65a: Advanced view shows how each verdict step's savings figure was estimated: measured or modeled, a near-point figure when the stage ran alone or a floor-to-optimistic range when it shared the cluster, the raw waste when the stage's floor clipped it or the resource waste the finding measured, and the finding's confidence marker. A line under the steps states how they are ordered.
- d7ea65a: Advanced view now has single-key triage shortcuts: `j`/`k` move between the verdict's steps and
  every finding row, `Enter` shows the focused finding's evidence, or expands a grouped finding, `f` jumps to the finding filters,
  and `1`/`2` switch between Findings and Full app report. They are listed in the keyboard shortcuts
  dialog (`?`) and stay off in the default view. The Advanced view toggle's "on" state is now a
  selected toggle (accent border, wash and dot) instead of a solid accent fill, so it no longer
  competes with the verdict's primary action.
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
- d7ea65a: Compare with another run from a run's dashboard. The top bar (the More options menu on a phone) opens the two-run compare view with the open run already in Run A, so checking whether a change helped means loading only the new run; the open run is reused, not parsed again, and Back to the run returns to its dashboard.
- d7ea65a: The run comparison page now leads with a verdict: whether run B finished faster or slower than run
  A and by how much, which cost metrics got worse or better (changes under 2% read as about the
  same), and which finding categories became more or less frequent (netted per category name, so a
  category never reads as both). When either run had failed jobs, the verdict leads with that
  instead, for example "Run B had 2 of 5 jobs fail (run A: none)" or "Run B's only job failed". When
  either log has no end-of-run record, the verdict says how much run time each log covers, in a
  neutral tone, rather than calling the cut-off run faster. A **See where to
  start in run B** button opens run B's dashboard and its own next steps. The page header also stacks
  on phones instead of pushing the page wider than the screen.
- d7ea65a: Copy next steps copies the run verdict as a plain checklist for a ticket or a message: the run and its verdict, the numbered steps with their stage, what to try and the savings, how many more places the full list holds, and what the log could not check.
- d7ea65a: The scorecard now explains itself: Wall-clock, Efficiency and Unused core time (renamed from Wastage)
  each say in Basic view what they measure and whether higher or lower is better, so a high
  Efficiency next to a high Unused core time no longer reads as a contradiction. Advanced view keeps the
  raw run and idle-time breakdown. Stage pills read "Stage 7" instead of "S 7". The verdict adds a
  collapsed "New to Spark tuning?" primer on stages, tasks, executors, shuffle, savings and impact
  colors, with a link to the finding guide; Advanced view hides it.
  
  On phones, finding rows now put the stage and savings on their own line under the recommendation
  instead of cutting them off at the screen edge.
- 4538c3e: HTML exports now carry their conclusions. The run verdict, next steps, what the log could not check, savings figures and run-shape numbers are computed when the file is exported, by both `--export-html` and **Download HTML dashboard**, so an exported dashboard always agrees with the report the same run produced. The export data format moves to version 2: an exported dashboard refuses a file of another version with a message instead of rendering it partially, and its footer names the tool, core version and build that produced it. An exported dashboard no longer offers **Export evidence**, since every format there reruns the analysis.
- d7ea65a: The run verdict says how the run ended. A run with a failed job leads with "This run failed" (or how many jobs failed), quotes the first line of the reason Spark recorded, and lists the failure before any speed-up; the step for that failure then points at the quoted reason and keeps the driver log for the full stack trace. A run whose jobs all succeeded says so. Finding rows no longer print a savings figure that rounds to zero, such as "0.0 core-h".
- e6f01b9: Evidence report schema 5 (CLI JSON, MCP `diagnose_run` and `get_finding_evidence`). A finding row's `evidence` now holds only the fields its finding type declares as evidence, so fields detectors kept for the impact estimator no longer appear: `stageShape`'s `totalCores`; `utilization`'s `utilizationFraction`, `appDurationMs` and `totalCores`; `memoryUtilization`'s `idleRateFraction`, `allocatedMB`, `peakExecutors`, `appDurationMs` and `allocatedBytes`; and `retryWaste`'s `extended` text. `value` is now always a number or `null`: `stageFailed`, `configAudit` and `incompleteRun` rows carry their text in a new `valueText` field instead. Finding ids are unchanged.
- d7ea65a: In Basic view, each impact band on the Findings tab leads with its recommendation rows and folds its detail widgets behind "Show the evidence". The collapsed widget cards used to follow every band as a second list that repeated the rows. Show evidence, from the verdict, a row or Full app report, opens the fold and lands on the finding. Advanced view shows every widget as before.
- 4feed5e: Download the self-contained HTML dashboard from the Export evidence menu. Until now it came only from the CLI's `--export-html`. The new item writes one `.html` file for the open run that opens in any browser with no server. It follows the Redact identifiers toggle and the Markdown and JSON naming, with a `-redacted` suffix when redaction is on. The main build ships the export template as `export-template.html` beside the app and fetches it only when someone picks HTML, so normal page loads don't carry it.
  
  Exported dashboards no longer link to docs, in either form. Finding tags and "learn more" references render as plain text, and the Docs button and the newcomer primer's guide pointer are left out, so an exported file names no docs address and needs no network. With nothing linking to it, the CLI's `--export-html` folder no longer ships a `docs/` copy. The build pieces that existed only for that copy are gone: the export build's docs step, VitePress's multi-page mode, and the step that rewrote copied docs paths to relative ones.
  
  The CLI and the dashboard now build the payload with the same core code: config audit, serialization, redaction, and the inline `window.__SPARKFORENSICS_RUN_GZ__` statement. The CLI's `data.js` is unchanged.
- d7ea65a: The landing page puts **Choose file** and **Try a sample run** in the first screen, directly under
  the headline and the docs links, instead of below the fold. A new **Where do I find my event log?** guide explains how
  to turn event logging on, where Spark writes the log, and how to download one from a Spark History
  Server. The parsing screen now says roughly how long is left, notes that the log stays on this
  machine, and has a **Cancel** button.
- 98591c4: The evidence report (CLI md/json, MCP `diagnose_run`, and the dashboard's Export evidence download) no longer lists checks the log could not run as clean. It uses the dashboard's rule: every per-stage check on a log where no stage finished, the run-span checks (`utilization`, `memoryUtilization`, `autoscalingChurn`) on a log with no end-of-run record, and any check whose only finding is a missing-data caveat move from `cleanChecks` to a new `notRunChecks` list. Each entry carries a `reason`, and the Markdown shows them under "Not checked on this log". The summary gains `actionableFindingCount` and `actionableImpactBandCounts`, which leave out evidence caveats and the incomplete-run row as the dashboard's top bar does, and `clean`, the dashboard's clean-run rule. The report's `schemaVersion` is now 4.
- 98591c4: The evidence report and MCP `get_run_summary` now say how the run ended, as the dashboard verdict does. The report summary gains `outcome` (`failedJobs`, `totalJobs`, `failureReason`, `failureReasonStageId`), and the Markdown adds a line such as "Outcome: 1 of 3 jobs failed. Spark's recorded reason (stage 1): ...", quoting only the first line of Spark's reason. `get_run_summary` returns the same four fields next to `runComplete`. With `redact`, its app identity now comes from the same redacted report, so a host in the app name and in the failure reason get the same pseudonym.
- 98591c4: The evidence report (CLI md/json, MCP `diagnose_run`, and the dashboard's Export evidence download) now opens with the dashboard's run verdict. A new `verdict` field carries the same title, summary sentences and first three next steps the verdict card shows, in the same order: grouped by place, ranked by potential savings, with failures first on a run whose jobs failed. Each step has its action, what to try, the potential savings and what that figure counts, and the other finding types flagged at the same place. `copyText` is the card's "Copy next steps" checklist. The Markdown adds a `## Verdict` section above "Fix these first", which stays: it ranks fix types, the verdict ranks places. The verdict's ranking and wording moved from the dashboard into the shared core package, so both paths run one implementation.
- 98591c4: Savings figures in the evidence report (CLI md/json, MCP, and the dashboard's Export evidence download) now read as the dashboard prints them. Memory reads in GB-h from 0.1 GB-h up instead of MB-s, core time in core-s or core-h instead of core-ms, and a figure that rounds to zero is left out instead of printing "0.0 core-h". Each figure says what it counts ("of run time", "of core time", "of unused executor memory"): `recommendations` rows gain `impactMeaning`, finding rows gain `impact` and `impactMeaning`, and the Markdown adds a `- estimate:` line explaining how each figure was derived.
  
  **Changed output:** time figures no longer carry an "Estimated" prefix. "Estimated 26.1s" is now "26.1s of run time", in `recommendations[].impact` and in the Markdown `impact:` lines. Update any script that matched the old prefix. The Markdown `- impact:` line now carries a single figure: it used to print the time range and the raw resource figure together, joined by a middot. The resource figure behind a time estimate has moved to the new `- estimate:` line, and a raw waste in milliseconds that is below the estimate's high is no longer printed.
  
  The `--min-efficiency` budget (and MCP `minEfficiencyPct`) detail now reads "Busy core time 26% below budget 90%." instead of "Efficiency 26% ...", so it no longer reads as the dashboard's Efficiency tile, which measures something else. What the flag measures, the share of executor core time that ran tasks, is unchanged, and so are its exit codes.
- 98591c4: The CLI `--stage` filter and MCP `diagnose_run`'s `stageId` now keep a SQL plan finding whose only stage is the one asked for, such as a small-files finding on stage 3, the same rule the dashboard's Stage details uses.
  
  The evidence report summary and MCP `get_run_summary` gain `runShape`, the run-shape figures the dashboard shows: wall-clock, Efficiency (the share of the run with a stage running), Unused core time, the ETL phases' summed stage time, and the peak busy cores from Core Usage by Locality. Each is null where the dashboard shows "Not measured" or "Unavailable", and the Markdown lists them under the header with what each one measures.
  
  Run from a repository checkout, the CLI, MCP and server entry points no longer silently use a leftover `vendor-core/` built from older core sources. They use it only while it matches `packages/core/src`, and otherwise print a one-line warning and run the current sources. The packed `vendor-core/` now records the hash of the sources it was built from.
- d7ea65a: The dashboard now opens with a run verdict: one line saying where to start, a short summary, and
  up to three numbered next steps. Each step says in plain language what is happening and what to
  try, and links to its evidence and stage details. Findings on the same stage fold into one step,
  since their savings overlap. Steps follow the same savings ranking as the rest of the dashboard. The separate "Highest impact" callout is gone,
  and the finding filter bar now shows in Advanced view, or whenever a filter is active.
- d7ea65a: The sample run says it is the sample. A line above its verdict explains that the board shows a real Spark job from a public example corpus, picked for its common problems, and offers Load my event log and a link to where to find one, so a newcomer who started from Try a sample run has a next step to their own log.
- d7ea65a: Stage details read like a verdict step. The dialog is titled "Stage N", with Spark's code-line stage name labelled as the code location, and opens with one sentence placing the stage in the run: how long it ran, its share of the run and its task count. Each finding shows its action, a plain explanation, what to try and its potential savings, ordered as the verdict orders them, with a Show evidence button that closes the dialog and jumps to the finding's widget.
- d7ea65a: The top bar's count chip agrees with the verdict and leads somewhere. It counts the findings the verdict ranks (config findings included, evidence caveats left out), reads "No findings" only for a run the verdict calls clean, "Not fully checked" when the log lacked evidence and "Run failed" when a job failed, and clicking it opens that band of the Findings list. A "Skip to the verdict" link is the first Tab stop on the dashboard.
- d7ea65a: The run verdict no longer calls a run clean when the log lacked evidence a check needs, such as executor metrics for memory or block updates for cache storage: a run is called clean only when nothing is missing, and a log in which no stage finished says so instead of "Every check passed".

### Patch Changes

- d7ea65a: Clean checks no longer lists checks the log could not run as passed. On a log with no finished stage, every per-stage check, and any check whose only finding is a missing-data caveat, moves to a neutral "Not checked on this log" group. So do the core usage, memory and executor churn checks on a log with no end-of-run record. The verdict uses the same rule.
- d7ea65a: Run comparison finding rows now carry the finding's `type` next to its `rule`, so a sub-rule such as
  `maxPartitionTooBig` can be grouped under its category (`partitionSizing`). The web comparison page's
  **Findings by category** list uses it, so sub-rule rows show their category tag instead of the raw
  rule name.
- d7ea65a: Core usage by locality moves from the Findings tab to the Full app report, beside the other run-wide charts, and its summary reads "busy at the peak". Show evidence on a locality finding now opens the Full app report and lands on the chart.
- d7ea65a: `--export-html` no longer opens to a blank page for a log with cached RDDs. The export payload flattened the run's RDD storage map and each stage's executor metrics to empty objects, so the Cache Storage card threw on load. Nested maps and sets now keep their type through the export, with or without `--redact`.
- e6f01b9: A finding's action label is now the same on every surface. Where a finding has no specific label, the dashboard, the verdict step and the report row all show the finding type's name; report rows used to show the raw type. The report's `cleanChecks` and `notRunChecks` now list `overBroadcast` and `underBroadcast`, matching the dashboard, where they used to list the `broadcastSizing` detector. The Config Audit widget's heading is now "Config Audit", the name used everywhere else, where it used to read "Config Sanity".
- 6b3c2ba: The Speculation waste (`SPEC`) finding now counts losing speculative attempts whose TaskEnd arrives
  after their stage's StageCompleted. Spark kills the losing copy only once the stage finishes
  ("Stage cancelled: Stage finished"), so on a real cluster this is the usual order, and the parser
  used to drop those attempts, leaving the finding silent for runs with speculation enabled. Only the
  stage's speculation waste totals change; every other stat still excludes late attempts.
- d7ea65a: Say what each verdict savings figure counts: run time, or the core time, unused memory or extra data a fix would recover. Large memory-time figures read in GB-hours instead of millions of MB-seconds, and core-time figures in core-hours or core-seconds instead of core-milliseconds.
- 98591c4: Run comparisons outside the dashboard now open with the dashboard comparison page's verdict. The CLI's `--baseline` output gains `comparison.verdict` in JSON (`title`, `tone`, `sentences`) and a verdict at the top of the Markdown "Comparison to baseline" section, which also names run A (the baseline) and run B (the candidate). MCP `compare_runs` returns the same `verdict`. It leads with failed jobs when either run had any ("Run A had 1 of 3 jobs fail; run B completed"), states the run-time change with a 2% noise band, never calls a cut-off log's shorter time faster, and names which cost metrics and finding categories moved each way. The verdict and the finding-tag names it uses moved from the dashboard into the shared core package, and the core comparison result now carries each run's job outcome, so the dashboard and the headless paths run one implementation.
- d7ea65a: Full app report figures now say what they measure. Stage Summary's "Flagged" column, which counted board widgets and showed "—" for a stage with three flags, is now "Findings", the number of finding types on the stage. Core usage no longer rounds a short run's peak down to "0 cores": a chart window that runs past the last stage's end is averaged over the part the stages cover. The expanded ETL phases card says phases are summed stage time, which is why a phase can exceed the run. The executor chart steps between counts instead of drawing fractional executors, and its tooltip reads "At 7s: Active executors 2". Chart tooltips draw on the theme's own surface, so they stay readable in the dark theme. The scaling estimate reads "with 5× the executors" instead of "at 500% executors", and a long card summary wraps under its value instead of cutting it off.
- e6f01b9: A tuned run now states and applies its thresholds consistently. `--max-skew` measures skew with the run's `skew.minTasksForP95`, so the budget checks the same ratio the skew finding reports. A tuned `floorPctWarn` or `floorPctCrit` on `skew` or `straggler` now grades that detector's impact bands. Caveat text that names a threshold (GC, skew, straggler, memory utilization, core locality) states the value the run used, not the default. The "estimate is unvalidated" caveat appears only on a tuned finding that has an estimate figure. A threshold file naming a built-in object key such as `constructor` or `toString` is refused as an unknown threshold. The MCP `compare_runs` Markdown now names the tuned thresholds, as `diagnose_run` does. The HTML export data format moves to version 3, so a dashboard built by this release refuses an older export with a message to export again, instead of rendering blank config-audit and stage-failure values. Default-threshold output is unchanged.
- 49ff617: Title each Spark Tuning Reference docs page "<Topic> | Spark Tuning Reference" and give it its own meta
  description from the reference manifest's `brief`, in place of the site-wide SparkForensics title suffix and
  description.
- d7ea65a: The Efficiency tile reads "Not measured" instead of a red "0%" when no stage in the log recorded an end, matching the verdict. Esc now closes the docs panel while focus is inside it, except while the docs' own search popup is open.

## 0.25.0

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

## 0.24.5

### Patch Changes

- fa49bd3: Skew and straggler estimates now replay each stage's own tasks instead of estimating the tail from P50, P95 and max. The parser schedules the stage's tasks in launch order on its observed peak slots twice, once as they ran and once with every task over 4x the median capped at the median, and the finding claims the difference. Clustered late stragglers now claim more, a long task that overlapped the rest of the stage claims less, and a speculation-driven stage with no task over 4x the median claims nothing. On 14 real logs this adds 4 findings, removes 2 and re-bands 5; every non-info estimate is within 2x of the replay (98 of 101 before).
- a7f6de4: `sparkforensics-mcp --help` now lists every registered tool, generated from the server itself. The History Server error text's "Local-server setup" link opens the getting-started section on local-server mode instead of the tuning reference intro.
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

## 0.24.4

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

## 0.24.3

### Patch Changes

- 97732c9: Bump @base-ui/react from 1.6.0 to 1.8.0.
- 97732c9: Bump eslint from 10.8.0 to 10.11.0.
- 97732c9: Bump globals from 17.8.0 to 17.12.0.
- 97732c9: Bump js-yaml from 5.4.1 to 5.4.2.
- 97732c9: Bump jsdom from 30.1.0 to 30.1.1.
- 97732c9: Bump playwright from 1.62.1 to 1.63.0.
- 97732c9: Bump react-resizable-panels from 4.12.4 to 4.13.2.
- 97732c9: Bump tailwind-merge from 3.6.0 to 3.7.0.
- 97732c9: Bump @tanstack/react-table from 8.21.3 to 9.2.4. Migrates `StageTable`'s `useReactTable` call to v9's explicit `tableFeatures`/`useTable` API (row sorting, row pagination, and column visibility, the last needed for `row.getVisibleCells()`); no behavior change.
- 97732c9: Bump @testing-library/jest-dom from 6.9.1 to 7.0.1. No setup changes needed: the repo already registers matchers via the `@testing-library/jest-dom/vitest` subpath, and `@testing-library/dom` (now a required peer) is already satisfied transitively through `@testing-library/react`.
- 97732c9: Bump @testing-library/user-event from 14.6.1 to 14.6.7.
- 97732c9: Bump vite from 7.3.6 to 8.3.0. `@vitejs/plugin-react`, `@tailwindcss/vite`, and `vite-plugin-singlefile` all already declare Vite 8 support at their current pinned versions, so no plugin bumps were needed alongside it.
- 97732c9: Bump vitest and @vitest/coverage-v8 from 4.1.11 to 5.0.1 everywhere (root, packages/core, packages/cli, packages/mcp). This also collapses packages/server's own already-bumped `vitest@^5.0.1` back into a single hoisted install, since every workspace member now shares the same major version.
  
  Two config changes went with it: `vitest.config.js`'s `poolOptions.threads.{execArgv,maxThreads}` moved to the top-level `execArgv`/`maxWorkers` options per v5's pool-options rework, and `packages/core/vitest.config.js` now excludes `src/docs-content/**` from coverage: v5's coverage-v8 remaps uncovered files through Rolldown, which errored trying to parse that directory's markdown reference content as JS.
- 97732c9: Bump @xyflow/react from 12.11.3 to 12.11.6.
- 97732c9: Bump zustand from 5.0.14 to 5.0.15.
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

## 0.24.2

### Patch Changes

- 7719736: Add coverage collection to each package's vitest config and CI job, reporting to Coveralls.
- 5af79cd: Clarify two beginner-facing messages. The "not a Spark event log" parse error now says "no application-start event found" and points to the docs instead of naming the internal `SparkListenerApplicationStart` event class. The Scorecard's wall-clock and efficiency tiles spell out "No stage activity recorded" for a zero-activity run instead of chaining into the shared `—` "no value" glyph, which read as broken data rather than an empty run.
- 5af79cd: Topbar now carries a "New analysis" home button and a persistent Docs link once a run is loaded, since both previously existed only on the landing screen and there was no way back. Finding-type tags that link to a doc page now get a visible underline so they read as linkable at a glance instead of only on hover; `incompleteRun` (INCMP), which had no vendor doc anchor, now links to its SparkForensics guide entry instead of rendering as inert text. FixTheseFirst's grouped-row trailing stat ("×2 · 476ms recoverable") now carries a spelled-out tooltip explaining the shorthand.
- 5af79cd: The landing page now offers a "Try a sample run" option for visitors who don't have a Spark event log of their own. It loads a bundled, gzip-compressed real event log (picked by running the analyzer over every corpus candidate and taking the one with the most findings) so a first-time user can see the dashboard without hunting for their own data.
- fc699ea: Bump @changesets/cli from 3.0.2 to 3.0.3.
- ff19377: Bump jsdom from 29.1.1 to 30.1.0.
- 04fc30d: Bump lucide-react from 1.24.0 to 1.47.0.
- ac586b2: Bump `react-dom` and `@types/react-dom` to 19.3.0, and `react` and `@types/react` to the matching `^19.3.0` so the peer-dependency ranges resolve without `--force`/`--legacy-peer-deps`.
- 02e13a5: Bump react-resizable-panels from 4.12.2 to 4.12.4.
- 6315cb4: Bump shadcn from 4.13.0 to 4.21.0.
- a9d17c2: Bump sonner from 2.0.7 to 2.0.8.
- ad1320b: Bump @testing-library/react from 16.3.2 to 16.3.3.
- 2158a9a: Bump @types/node from 22.20.1 to 26.6.2.
- bbd90eb: Bump zod from 4.4.3 to 4.6.5.
- eb92d78: Exclude the vendored decompressors (fflate, fzstd) from packages/core's coverage report, matching the root config, and add tests for previously-uncovered core logic (finding-action-label, model-assembler, format-utils, parser-worker's multi-file error paths, ingest's worker-message routing). No runtime behavior change.
- 50c7b4b: Spell out "Estimated" instead of "Est." for the wall-clock impact prefix in the Markdown evidence report. The abbreviation only saved space in the web UI; the Markdown report now reads as a full phrase.
- 4981e0e: Vary confidence for eight more findings (skew, gc, straggler, speculationWaste, memoryUtilization's waste-model, coreLocality, autoscalingChurn, cachingOpportunity) with the strength of their underlying evidence instead of hardcoding `'low'`. Each now scales off that detector's own existing thresholds: skew and gc score how many multiples past their ratio/percentage floor a finding sits; straggler, speculationWaste, memoryUtilization and autoscalingChurn do the same against their own warn/critical tiers; coreLocality additionally weighs task-sample size, taking whichever signal is weaker; cachingOpportunity scales with how many executions repeat the same relation or plan shape past the minimum needed to fire at all.
- 91d197a: Vary confidence for the cacheUtilization and duplicatePlanSubtree findings with the strength of their underlying evidence instead of hardcoding `'medium'`. cacheUtilization's per-RDD cached/disk ratios now scale confidence with `numPartitions`: below 10 partitions a single partition flipping cached/evicted swings the reported percentage too much to trust (`low`), 50+ partitions makes the ratio stable (`high`). duplicatePlanSubtree's structural-fingerprint match (operator + metric names only, not literal values) now scales confidence with how far the matched subtree clears its own thresholds: a match at the bare minimum size and occurrence count is the case most likely to be coincidental (`low`), while a much bigger or more-repeated match is strong corroborating evidence (`high`).
- 0a8600d: Remove "unvalidated"/"unverified" hedging language from finding caveat text, the What-If Executor Scaling widget, and the design-spike confidence badge. The `confidence` field and its tooltip mechanism are unchanged; only the prose describing findings as uncalibrated against an external tool was reworded.
- 198b5c2: Run comparison's `confidence` field now also drops to `low` when matched stage coverage is below 50%, not just on an app-name mismatch, so two same-named runs that barely share any stages no longer report `ok`.
- a2e71e4: Bump vitest to 5.0.1 in packages/server and sync the root lockfile with it. Remove packages/server's own package-lock.json: as an npm-workspaces member, CI only ever installed from the root lockfile, so the nested one was dead weight that a directory-scoped Dependabot update could drift out of sync with (as this bump did, breaking `npm ci`). Dependabot's `/packages/server` entry is removed too, since the root entry already covers every workspace member's dependencies.

## 0.24.1

### Patch Changes

- 6eb445d: Show the site's version in the keyboard shortcuts dialog.
