# `get_finding_evidence`

Reference for the `get_finding_evidence` tool of the SparkForensics MCP server.

The finding row for one finding id, the same shape as a `diagnose_run`
`findings` entry. Use it to re-read one finding by id without the rest of the
report.

Parameters (`runId` and `findingId` are both required: call `diagnose_run`
first to get a `runId` and a finding's `id`):

- `runId`: `string`
- `findingId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id and any
  host/IP tokens in the response

Example call:

```json
{ "name": "get_finding_evidence", "arguments": { "runId": "b8b2c1a4-...", "findingId": "1d473001" } }
```

Example response:

```json
{
  "runId": "b8b2c1a4-...",
  "finding": {
    "id": "1d473001",
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
