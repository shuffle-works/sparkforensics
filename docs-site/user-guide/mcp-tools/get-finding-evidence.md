# `get_finding_evidence`

Reference for the `get_finding_evidence` tool of the SparkForensics MCP server.

The finding row for one finding id, the same shape as a `diagnose_run`
`findings` entry. Use it to re-read one finding by id without the rest of the
report.

Parameters (`findingId` is required, and so is `runId` or `source`: call
`diagnose_run` first to get a `runId` and a finding's `id`):

- `runId`: `string`, from an earlier `diagnose_run` call in this server process
- `source`: the run to analyse when `runId` is missing or not cached, as in
  [`diagnose_run`](./diagnose-run.md). A cached run is used as it is. A finding's
  `id` is the same in a new analysis, so an `id` from before a restart resolves.
- `appId`: `string`, the application `source` must hold, as `diagnose_run` names
  it (a pseudonym with `redact`). Needs `source`. Another application fails with
  `run-not-found`.
- `findingId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id, host
  names and user names in the response. See [What `--redact` covers](../getting-started/ci-and-automation.md#what-redact-covers)

Example call:

```json
{ "name": "get_finding_evidence", "arguments": { "runId": "b8b2c1a4-...", "findingId": "1d473001" } }
```

After a server restart, pass the `source` and `appId` of the run instead of the `runId`:

```json
{ "name": "get_finding_evidence", "arguments": { "source": { "path": "app-20260101.zstd" }, "appId": "application_0000000000000_0001", "findingId": "1d473001" } }
```

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
