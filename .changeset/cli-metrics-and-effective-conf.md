---
"sparkforensics-cli": minor
"sparkforensics-mcp": patch
"sparkforensics-web": patch
---

Machine-readable run metrics and effective Spark conf in the CLI's JSON output, for tools that tune a job without reading a report.

- `metrics` block beside the report (inside `candidate` with `--baseline`), with its own `schemaVersion`. Run totals for time, data, shape (failed stage attempts and resubmitted stages, apart from task retries) and allocation (allocated core-hours and memory GB-hours from the executor lifecycle), `runComplete`, the share of task run time spent in Python stages, and per-stage rows keyed by the stage fingerprint the run comparison uses. A figure the log cannot provide is `null`, never `0`.
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
