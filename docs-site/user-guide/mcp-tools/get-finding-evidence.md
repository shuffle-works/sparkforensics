# `get_finding_evidence`

Reference for the `get_finding_evidence` tool of the SparkForensics MCP server.

The finding row for one finding id, the same shape as a `diagnose_run`
`findings` entry. Use it to re-read one finding by id without the rest of the
report.

Parameters (`findingId` is required, and so is `runId` or `source`: call
`diagnose_run` first to get a `runId` and a finding's `id`):

- `runId`: `string`, the run of an earlier `diagnose_run` call in this server
  process
- `source`: the run to analyse when `runId` is missing or not cached,
  the same `source` as in [`diagnose_run`](./diagnose-run.md). A cached run is
  used as it is. Otherwise the run is loaded from `source`, which analyses it
  again unless the same unchanged source is cached. A finding's `id` is the
  same in the new analysis, so an `id` from before a server restart resolves.
- `appId`: `string`, the Spark application the finding belongs to. Needs
  `source`. The call fails with `run-not-found` when the log holds another
  application.
- `findingId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id, host
  names and user names in the response. See [What `--redact` covers](../getting-started/ci-and-automation.md#what-redact-covers)

Example call:

```json
{ "name": "get_finding_evidence", "arguments": { "runId": "b8b2c1a4-...", "findingId": "1d473001" } }
```

After a server restart the `runId` is gone. Pass the `source` and `appId` of the run instead:

```json
{ "name": "get_finding_evidence", "arguments": { "source": { "path": "app-20260101.zstd" }, "appId": "application_0000000000000_0001", "findingId": "1d473001" } }
```

The response carries the `runId` of the new analysis.

Example response:

```json
{
  "runId": "b8b2c1a4-...",
  "finding": {
    "id": "1d473001",
    "key": "incompleteRun|incompleteRun|run",
    "type": "incompleteRun",
    "name": "Incomplete Run",
    "tag": "INCMP",
    "impactBand": "warning",
    "stageId": null,
    "metric": "applicationEnd",
    "value": null,
    "valueText": "missing",
    "recommendation": "This event log never recorded an ApplicationEnd event: the capture stopped before the run finished...",
    "detectorVersion": 1,
    "evidence": {},
    "remediation": [],
    "actionLabel": "incomplete run",
    "impactEstimate": { "basis": "informational", "wallClock": null, "estimateMethod": "none", "coreTimeMs": null }
  }
}
```
