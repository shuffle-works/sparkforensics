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
- The parser records each stage's rows written (`outputRecords`) and counts its attempts across resubmits (`stageAttempts`, `failedStageAttempts`).
