# `diagnose_run`

Reference for the `diagnose_run` tool of the SparkForensics MCP server.

Diagnose a Spark run: thresholded findings with remediation text, led by the
same verdict the dashboard opens with. `verdict` gives a `title` ("Start with
Stage 3", "1 of 3 jobs failed in this run"), `summary` sentences, `steps`, the
first three places to look in the dashboard's order (each with its action, what
to try, the potential savings and what that figure counts, and the other
finding types flagged at the same place), `remainingPlaces`, how many more
places the full list holds, and `copyText`, the dashboard's "Copy next steps"
checklist.

Parameters (all optional, but pass either a `source` to load a fresh run, or
a `runId` for one already loaded in this session; passing neither is an
error, and when both are given `runId` wins):

- `source`: `{ path: string }` or `{ shsBaseUrl: string, appId: string, attemptId?: string }`.
  A History Server `appId` must have one of Spark's id forms
  (`application_<digits>_<digits>`, `local-<digits>`, `app-...`, `spark-...`,
  `driver-<digits>`).
- `runId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id and any
  host/IP tokens in the response, and replaces the app name with the app
  id's pseudonym
- `include`: array of `"summary" | "evidenceAvailability" | "detectors"`
  (default omitted, i.e. none). Each requested value adds one extra top-level
  field to the response, on top of the default `verdict`/`findings`/`recommendations`/
  `cleanChecks`/`notRunChecks`/`runComplete`:
  - `summary`: app id/name/Spark version, stage/job/SQL-execution counts, a
    finding count broken down by impact band, the same counts without evidence
    caveats and the incomplete-run row (`actionableFindingCount`,
    `actionableImpactBandCounts`, what the dashboard counts), `outcome` (how
    the run ended), `runShape` (as in `get_run_summary`), `clean`, and
    `tunedThresholds` on a tuned server
  - `evidenceAvailability`: which event types the log actually contained, so
    you can tell "this check came back clean" apart from "this check
    couldn't run because the log is missing data"
  - `detectors`: the full catalog of checks this tool can run: type, version,
    scope (stage/sql/app/config), current thresholds, and a doc-page anchor
  This is opt-in because `detectors` in particular is a large, mostly-static
  catalog that would bloat a routine "what's wrong with this run" call.
- `impactBand`: array of impact bands (e.g. `["critical", "warning"]`),
  narrows the `findings` array to only these bands
- `type`: array of finding `type` values, narrows `findings` to only these
  types
- `stageId`: number, narrows `findings` to only findings on this stage,
  including a SQL plan finding whose only stage it is (the dashboard's stage
  details rule)
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

`impactBand`/`type`/`stageId` only filter the `findings` array:
`verdict`, `recommendations`, `cleanChecks`, `notRunChecks`, and the finding counts in `summary` (when
requested via `include`) always stay computed from the full, unfiltered set,
so a narrow filter never hides that other checks passed or other fixes exist.

A `runId` expires. Loaded runs are cached in memory, capped at 8
(LRU-evicted) and expired 15 minutes after their last use (override with
`SPARKFORENSICS_MCP_CACHE_CAP` and `SPARKFORENSICS_MCP_CACHE_TTL_MS`). Loading
the same unchanged `source` again while it is cached returns the same `runId`. A
`runId` from an earlier `diagnose_run` call may not resolve when you pass it
to `get_finding_evidence`, `compare_runs`, or `evaluate_budgets`; re-load the
run with `source` if you get `run-not-found`.

Example call:

```json
{ "name": "diagnose_run", "arguments": { "source": { "path": "app-20260101.zstd" } } }
```

Example response (an event log with no `ApplicationEnd` event; fields
trimmed: `verdict`, `recommendations`, `cleanChecks`, `notRunChecks` and the
other findings are left out):

```json
{
  "runId": "b8b2c1a4-...",
  "runComplete": false,
  "findings": [
    {
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
  ]
}
```

The figure that drove a finding is in the row's `metric` and `value` (or `valueText`).
`evidence` holds type-specific extra fields and is empty for several types,
such as `incompleteRun` above and `skew`.
