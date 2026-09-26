# MCP tools reference

SparkForensics has an MCP server with eight tools, so an MCP-aware client (or
an AI agent) can diagnose a run without opening the dashboard.

Five of the eight tools (`list_runs`, `diagnose_run`, `get_run_summary`,
`compare_runs`, `get_finding_evidence`) accept an optional `redact: boolean`
parameter (default `false`) that pseudonymizes the app id and any host/IP
tokens in the response (`app-1`, `host-1`, ...), so a result can be shared
outside the environment that produced it. On `compare_runs`, `runIdA`/
`runIdB` are caller-supplied identifiers, not Spark application ids, so
there's no single app-id field to redact; `redact` instead scans stage names
and other free text for embedded app ids and host/IP tokens and
pseudonymizes those. `list_runs` pseudonymizes every run's app id and name
consistently, so two attempts of the same app still redact to the same
identity across the list.

## Connecting a client

Run the server with `npx`:

```
npx sparkforensics-mcp
```

Or point an MCP client (Claude Desktop, Claude Code) at it with this config:

```json
{
  "mcpServers": {
    "sparkforensics": {
      "command": "npx",
      "args": ["sparkforensics-mcp"]
    }
  }
}
```

## `diagnose_run`

Diagnose a Spark run: thresholded findings with remediation text.

Parameters (all optional: provide either a `source` to load a fresh run, or
a `runId` for one already loaded in this session):

- `source`: `{ path: string }` or `{ shsBaseUrl: string, appId: string, attemptId?: string }`
- `runId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id and any
  host/IP tokens in the response
- `include`: array of `"summary" | "evidenceAvailability" | "detectors"`
  (default omitted, i.e. none). Each requested value adds one extra top-level
  field to the response, on top of the default `findings`/`recommendations`/
  `cleanChecks`/`notRunChecks`/`runComplete`:
  - `summary`: app id/name/Spark version, stage/job/SQL-execution counts, a
    finding count broken down by impact band, the same counts without evidence
    caveats and the incomplete-run row (`actionableFindingCount`,
    `actionableImpactBandCounts`, what the dashboard counts), and `clean`
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
- `stageId`: number, narrows `findings` to only findings on this stage
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

`impactBand`/`type`/`stageId` only filter the `findings` array:
`recommendations`, `cleanChecks`, `notRunChecks`, and the finding counts in `summary` (when
requested via `include`) always stay computed from the full, unfiltered set,
so a narrow filter never hides that other checks passed or other fixes exist.

A `runId` expires. Loaded runs are cached in memory, capped at 8
(LRU-evicted) and expired after 15 minutes (override with
`SPARKFORENSICS_MCP_CACHE_CAP` and `SPARKFORENSICS_MCP_CACHE_TTL_MS`). A
`runId` from an earlier `diagnose_run` call may not resolve when you pass it
to `get_finding_evidence`, `compare_runs`, or `evaluate_budgets`; re-load the
run with `source` if you get `run-not-found`.

Example call:

```json
{ "name": "diagnose_run", "arguments": { "source": { "path": "app-20260101.zstd" } } }
```

Example response (an event log with no `ApplicationEnd` event):

```json
{
  "runId": "b8b2c1a4-...",
  "runComplete": false,
  "findings": [
    {
      "id": "incompleteRun-1",
      "type": "incompleteRun",
      "name": "Incomplete Run",
      "tag": "INCMP",
      "impactBand": "warning",
      "stageId": null,
      "recommendation": "This event log never recorded an ApplicationEnd event: the capture stopped before the run finished...",
      "detectorVersion": 1,
      "evidence": {}
    }
  ]
}
```

The `evidence` shape is detector-specific. The example above is
`incompleteRun`'s, which is empty; other detectors attach the metrics that
drove the finding.

## `get_run_summary`

App/stage/job/sql counts, duration, and how the run ended: no findings.
`failedJobs`/`totalJobs` count only jobs with an end record, and
`failureReason` is the first line of Spark's own recorded reason when a job
failed, the same line the dashboard verdict quotes (`failureReasonStageId` is
the stage it came from, or `null` when it came from a job's exception).

Parameters: same as `diagnose_run` (`source`, `runId`, `redact`, all optional).

Example call:

```json
{ "name": "get_run_summary", "arguments": { "source": { "path": "app-20260101.zstd" } } }
```

Example response:

```json
{
  "runId": "3f9c2b7e-...",
  "app": { "id": "app-1", "name": "t", "sparkVersion": null },
  "stageCount": 0,
  "jobCount": 0,
  "sqlExecutionCount": 0,
  "executorCount": { "added": 0, "removed": 0 },
  "durationMs": 100,
  "runComplete": true,
  "failedJobs": 0,
  "totalJobs": 0,
  "failureReason": null,
  "failureReasonStageId": null
}
```

## `evaluate_budgets`

Evaluate a run against pass/fail thresholds: the MCP equivalent of the CLI's
`--max-runtime`/`--max-spill`/etc. budget flags, thin-wrapped over the same
`evaluateBudgets()` the `sparkforensics-analyze` CLI uses.

Parameters (all optional):

- `source` / `runId`: identify the run to evaluate (same shape as
  `diagnose_run`). When `runIdB`/`sourceB` is also given, this run is the
  regression baseline instead.
- `maxRuntimeMs`, `maxSpillGb`, `maxSkewRatio`, `maxFailedTaskRatePct`,
  `minEfficiencyPct`: absolute budgets, each evaluated only if provided. With
  two runs they apply to the candidate (`runIdB`/`sourceB`), the same as the
  CLI's `--baseline` mode.
- `runIdB` / `sourceB`: a candidate run to compare against the first, so
  regression budgets can be evaluated. Same `runId`/`source` shape, resolved
  the same way. Omit both to skip regression budgets.
- `maxRegressionPct`, `regressionMetric`: fail if `regressionMetric` (default
  `wallClock`; see [Regression metric keys](./getting-started.md#regression-metric-keys)
  for the full list) regressed by more than `maxRegressionPct`% between the
  first run (baseline) and the second run (candidate). Requires
  `runIdB`/`sourceB`.
- `failOnIntroduced`: fail if the second run introduces any finding in the
  given impact band (`"all"` or one of the impact band names). Requires
  `runIdB`/`sourceB`.

A budget whose required evidence is missing (e.g. no `runIdB`/`sourceB` for a
regression budget, or a run with no trustworthy task-level evidence) reports
`inconclusive`, not a false pass. Independent of which budgets you pass, an
evaluated run with no ApplicationEnd event adds a `run-complete` result with
status `inconclusive`, the same check that makes the CLI exit `3`. With two
runs, the check applies to the candidate.

Example call:

```json
{
  "name": "evaluate_budgets",
  "arguments": {
    "source": { "path": "baseline.zstd" },
    "sourceB": { "path": "candidate.zstd" },
    "maxRegressionPct": 10,
    "failOnIntroduced": "critical"
  }
}
```

Example response:

```json
{
  "runId": "aaaa1111-...",
  "results": [
    {
      "name": "max-regression",
      "status": "violation",
      "detail": "Metric \"wallClock\" regressed 100.0%, exceeding budget 10%."
    },
    {
      "name": "fail-on-introduced",
      "status": "pass",
      "detail": "No introduced findings match \"critical\"."
    }
  ],
  "violated": true,
  "inconclusive": false
}
```

## `compare_runs`

Compare two runs: categorized findings delta and metric deltas.

Parameters:

- `runIdA` / `sourceA`: identify run A (same `source` shape as above)
- `runIdB` / `sourceB`: identify run B
- `redact`: `boolean` (default `false`), pseudonymizes any app id or host/IP
  tokens embedded in free text (stage names and similar) in the response: see
  the note at the top of this page
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

Each side takes either a `runId` or a `source`, and you can mix them: a
cached run ID for the baseline, a fresh file for the candidate.

Example call:

```json
{
  "name": "compare_runs",
  "arguments": {
    "sourceA": { "path": "baseline.zstd" },
    "sourceB": { "path": "candidate.zstd" }
  }
}
```

Example response:

```json
{
  "runIdA": "aaaa1111-...",
  "runIdB": "bbbb2222-...",
  "findingsDelta": { "introduced": [], "resolved": [] },
  "metricDeltas": [
    {
      "key": "wallClock",
      "label": "Wall-clock duration",
      "baseline": 2000,
      "candidate": 1000,
      "delta": -1000,
      "direction": "improvement"
    }
  ],
  "confidence": "ok",
  "reason": null,
  "matchedCoverage": 1
}
```

## `get_finding_evidence`

Raw evidence bundle backing one finding, for drill-down after
`diagnose_run`.

Parameters (`runId` and `findingId` are both required: call `diagnose_run`
first to get a `runId` and a finding's `id`):

- `runId`: `string`
- `findingId`: `string`
- `redact`: `boolean` (default `false`), pseudonymizes the app id and any
  host/IP tokens in the response

Example call:

```json
{ "name": "get_finding_evidence", "arguments": { "runId": "b8b2c1a4-...", "findingId": "incompleteRun-1" } }
```

Example response:

```json
{
  "runId": "b8b2c1a4-...",
  "finding": {
    "id": "incompleteRun-1",
    "type": "incompleteRun",
    "name": "Incomplete Run",
    "tag": "INCMP",
    "impactBand": "warning",
    "stageId": null,
    "recommendation": "This event log never recorded an ApplicationEnd event: the capture stopped before the run finished...",
    "detectorVersion": 1,
    "evidence": {}
  }
}
```

## `get_finding_documentation`

Detection and tuning reference documentation for one finding type,
independent of any run: fetch it once per type (not once per finding) and
cache it.

Parameters:

- `type`: `string` (required): a finding `type` value, e.g. `"skew"`

Example call:

```json
{ "name": "get_finding_documentation", "arguments": { "type": "skew" } }
```

Example response:

```json
{
  "type": "skew",
  "name": "Task Skew",
  "detectionDoc": {
    "tag": "SKEW",
    "title": "Task skew",
    "content": "### `SKEW`: Task skew {#skew}\n\nA small number of tasks..."
  },
  "tuningDoc": {
    "anchor": "#bottleneck-skew",
    "title": "Task skew",
    "content": "# Task skew\n\n..."
  }
}
```

`tuningDoc` is `null` when the finding type has no vendored tuning-doc page.
This isn't exhaustive, but two examples: `configAudit` (its four audited
properties each have their own anchor rather than one shared page, so no
single anchor resolves) and `incompleteRun` (no upstream tuning page covers
this signal at all). A type whose section lives on a general chapter rather
than a bottleneck page (`autoscalingChurn` on Cluster Tuning,
`cacheUtilization` on Memory Management) returns that whole chapter, with
`anchor` naming the section.

## `get_reference_doc`

Full tuning-reference chapter or bottleneck markdown for one doc anchor
(e.g. `"#joins"`, `"#bottleneck-skew"`, `"#metric-task-duration"`),
independent of any run, so a client without browser access can read the same
reference material the dashboard links to.

Parameters:

- `anchor`: `string` (required): a doc anchor, with or without the leading `#`

Example call:

```json
{ "name": "get_reference_doc", "arguments": { "anchor": "#bottleneck-skew" } }
```

Example response:

```json
{
  "anchor": "bottleneck-skew",
  "title": "Task skew",
  "content": "# Task skew\n\n..."
}
```

An anchor that resolves to no known page returns the `invalid-anchor` error
code (see Errors below).

## `list_runs`

List candidate Spark event-log runs from a local directory or a Spark
History Server, before diagnosing one with the tools above. Local-mode
scanning is non-recursive: only the files and rolling-log subdirectories
directly inside `dir` are considered.

Parameters:

- `dir` (string, local mode) or `shsBaseUrl` (string, SHS mode): exactly
  one of the two.
- `namePattern` (string, optional): case-insensitive substring match against
  each run's name.
- `minDate`/`maxDate` (string, optional): filter by start time. A value
  that doesn't parse as a date fails with `invalid-date-filter`.
- `maxResults` (number, optional, default 100): caps the number of runs
  returned; when more candidates matched, `truncated` is `true`.
- `redact` (boolean, optional, default `false`): pseudonymizes every run's
  app id and name (see the note at the top of this page).

Example call:

```json
{ "name": "list_runs", "arguments": { "dir": "/var/log/spark-events" } }
```

Example response:

```json
{
  "runs": [
    {
      "appId": "application_1700000000000_0001",
      "name": "MyApp",
      "sparkVersion": "3.5.0",
      "startTime": "2026-01-01T12:00:00.000Z",
      "source": { "path": "/var/log/spark-events/application_1700000000000_0001" }
    }
  ],
  "truncated": false
}
```

Each entry's `source` is the same shape `diagnose_run`/`get_run_summary`
accept as `source`, so a result row can be passed straight into those tools
without re-deriving anything.

## Errors

All eight tools report failure the same way:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "<error message>" }],
  "structuredContent": { "code": "<error-code>" }
}
```

The codes:

- `run-not-found`: no cached run for the `runId` you passed.
- `finding-not-found`: that `findingId` isn't on that run.
- `invalid-date-filter`: `list_runs`'s `minDate` or `maxDate` isn't a
  parseable date.
- `invalid-type`: that finding `type` isn't one `get_finding_documentation` recognizes.
- `invalid-anchor`: that `anchor` doesn't resolve to a known `get_reference_doc` page.
- `invalid-event-log`: the file doesn't exist, or the event log (or History
  Server archive) couldn't be decoded.
- `application-not-found`: the History Server returned a 404 for that
  `appId`/`attemptId`.
- `upstream-unreachable`: the History Server response stalled mid-body.
  Override the idle timeout with `SPARKFORENSICS_SHS_TIMEOUT_MS`. If the
  server is unreachable entirely (an SSH-only cluster), see
  [Alternative ways to get the logs](./alternative-log-retrieval.md).
- `archive-too-large`: the History Server archive blew the byte cap.
  Override it with `SPARKFORENSICS_MAX_ARCHIVE_BYTES`.
- `directory-not-found`: `list_runs`'s `dir` doesn't exist or isn't readable.
- `invalid-shs-base-url`: `list_runs`'s `shsBaseUrl` isn't an absolute
  HTTP(S) URL without credentials, query, or fragment.
- `access-or-upstream-failure`: the fallback code. Bad parameters, a failed
  History Server fetch, or any error that carries no more specific code.
