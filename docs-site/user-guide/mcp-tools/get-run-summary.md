# `get_run_summary`

Reference for the `get_run_summary` tool of the SparkForensics MCP server.

App/stage/job/sql counts, duration, and how the run ended: no findings.
`failedJobs`/`totalJobs` count only jobs with an end record, and
`failureReason` is the first line of Spark's own recorded reason when a job
failed, the same line the dashboard verdict quotes (`failureReasonStageId` is
the stage it came from, or `null` when there is no reason or it came from a
job's exception).
`runShape` carries the dashboard's run-shape figures: `wallClockMs`,
`efficiencyPct` (the share of the run with a stage running, the Scorecard's
Efficiency), `unusedCoreTimePct` (the share of executor core time that ran no task,
against the run's allocation, cores times the time each executor was alive; `minEfficiencyPct` checks 100 minus this), `etlPhasesMs`
(`extract`/`transform`/`load` summed stage time, so a phase can exceed the run)
and `peakBusyCores` (busy cores at the peak of Core Usage by Locality,
averaged over one chart bucket, so it can be fractional). Each is `null` where the
dashboard shows "Not measured" or "Unavailable".

Parameters: `source`, `runId` and `redact`, as in `diagnose_run`.

Example call:

```json
{ "name": "get_run_summary", "arguments": { "source": { "path": "app-20260101.zstd" } } }
```

Example response:

```json
{
  "runId": "3f9c2b7e-...",
  "app": { "id": "application_0000000000000_0001", "name": "t", "sparkVersion": null },
  "stageCount": 0,
  "jobCount": 0,
  "sqlExecutionCount": 0,
  "executorCount": { "added": 0, "removed": 0 },
  "durationMs": 100,
  "runComplete": true,
  "failedJobs": 0,
  "totalJobs": 0,
  "failureReason": null,
  "failureReasonStageId": null,
  "runShape": { "wallClockMs": 100, "efficiencyPct": null, "unusedCoreTimePct": null, "etlPhasesMs": null, "peakBusyCores": null }
}
```
