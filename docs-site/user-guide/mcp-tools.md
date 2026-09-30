# MCP tools reference

SparkForensics has an MCP server with eight tools, so an MCP-aware client (or
an AI agent) can diagnose a run without opening the dashboard.

Five of the eight tools (`list_runs`, `diagnose_run`, `get_run_summary`,
`compare_runs`, `get_finding_evidence`) accept an optional `redact: boolean`
parameter (default `false`) that pseudonymizes the app id and any host/IP
tokens in the response (`app-1`, `host-1`, ...), so a result can be shared
outside the environment that produced it. The app name is as identifying as
the id, so every tool replaces it with the app id's pseudonym. It also
pseudonymizes the value of any field named `host`, and drops the message and
stack text of failed-task errors and the failure reason of a failed stage, which
can carry file paths and data values that no pattern recognizes. On `compare_runs`, `runIdA`/
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

To tune detector thresholds, start the server with `--thresholds <file>`
(add `"--thresholds", "/absolute/path/thresholds.json"` to `args`). The file
format is the CLI's: see
[Tuning detector thresholds](./getting-started.md#tuning-detector-thresholds).
The overrides apply to every tool for the life of the server; a client can't
change them per call. An unreadable or invalid file stops the server from
starting: it exits with status 2, with the problem on stderr.
`sparkforensics-mcp --help` prints the usage and the tool list. On a tuned
server, `diagnose_run`, `compare_runs` and `evaluate_budgets` add a top-level `tunedThresholds`, and
each finding and clean check from a tuned detector carries its own
`tunedThresholds`, as in the CLI report. The Markdown output of
`diagnose_run` and `compare_runs` names the tuned thresholds too.

### Connecting over HTTP

The local server (`npx sparkforensics-server`, see
[Run it locally](./getting-started.md#local-server-mode)) also serves the
same eight tools over MCP's streamable HTTP transport at
`http://127.0.0.1:4173/mcp` (or the port you pass with `--port`). Point a
client that speaks streamable HTTP, such as Claude Code, at that URL:

```json
{
  "mcpServers": {
    "sparkforensics": { "type": "http", "url": "http://127.0.0.1:4173/mcp" }
  }
}
```

It is for clients on the same machine only. The server listens on
127.0.0.1, and a request whose `Host` header isn't `127.0.0.1:<port>` or
`localhost:<port>` gets a 403, which blocks DNS-rebinding attacks from web
pages. Use `127.0.0.1` in the URL: `localhost` can resolve to the IPv6
address `::1`, where the server doesn't listen.

The endpoint always runs the default detector thresholds: the server takes
no `--thresholds` flag. To tune thresholds, run `sparkforensics-mcp` over
stdio instead. Runs are cached in the server process as they are for
`sparkforensics-mcp`, so a `runId` from one request works in later ones
until it expires. A relative `source.path` resolves against the directory
you started the server from. The examples below use short relative names;
pass an absolute path when in doubt.

## `diagnose_run`

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
      "actionLabel": "incomplete run",
      "impactEstimate": { "basis": "informational", "wallClock": null, "estimateMethod": "none" }
    }
  ]
}
```

The figure that drove a finding is in the row's `metric` and `value` (or `valueText`).
`evidence` holds type-specific extra fields and is empty for several types,
such as `incompleteRun` above and `skew`.

## `get_run_summary`

App/stage/job/sql counts, duration, and how the run ended: no findings.
`failedJobs`/`totalJobs` count only jobs with an end record, and
`failureReason` is the first line of Spark's own recorded reason when a job
failed, the same line the dashboard verdict quotes (`failureReasonStageId` is
the stage it came from, or `null` when there is no reason or it came from a
job's exception).
`runShape` carries the dashboard's run-shape figures: `wallClockMs`,
`efficiencyPct` (the share of the run with a stage running, the Scorecard's
Efficiency), `unusedCoreTimePct` (the share of executor core time that ran no task,
against peak concurrent cores; `minEfficiencyPct` checks 100 minus this), `etlPhasesMs`
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
  CLI's `--baseline` mode. `minEfficiencyPct` measures busy core time, the
  share of executor core time that ran tasks (100 minus the dashboard's
  Unused core time), not the dashboard's Efficiency tile. `maxFailedTaskRatePct`
  reads the task failure rate off the `jobFailureRate` finding, so when that
  finding didn't fire (under 10% of jobs failed, by default) it passes whatever
  the task failure rate.
- `runIdB` / `sourceB`: a candidate run to compare against the first, so
  regression budgets can be evaluated. Same `runId`/`source` shape, resolved
  the same way. Omit both to skip regression budgets.
- `maxRegressionPct`, `regressionMetric`: fail if `regressionMetric` (default
  `wallClock`; see [Regression metric keys](./getting-started.md#regression-metric-keys)
  for the full list) regressed by more than `maxRegressionPct`% between the
  first run (baseline) and the second run (candidate). Requires
  `runIdB`/`sourceB`. `regressionMetric` without `maxRegressionPct` fails the
  call. A volume key (`inputBytes`, `outputBytes`, `taskCount`,
  `executorsAdded`), which has no regression direction, or an unknown key
  reports `inconclusive`.
- `failOnIntroduced`: fail if the second run introduces any finding in the
  given impact band (`"all"` or one of the impact band names). Requires
  `runIdB`/`sourceB`. A band name it doesn't recognize reports `inconclusive`.

A budget whose required evidence is missing (e.g. no `runIdB`/`sourceB` for a
regression budget, or a run with no trustworthy task-level evidence) reports
`inconclusive`, not a false pass. Independent of which budgets you pass, an
evaluated run with no ApplicationEnd event adds a `run-complete` result with
status `inconclusive`, the same check that makes the CLI exit `3`. With two
runs, the check applies to the candidate.

Each result's `name` is one of `max-runtime`, `max-spill`, `max-skew`,
`max-failed-task-rate`, `min-efficiency`, `max-regression`,
`fail-on-introduced` and `run-complete`. The returned `runId` is the first
run's (the baseline, when two runs are given).

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

Compare two runs: the comparison page's verdict, categorized findings delta
and metric deltas. `verdict` is the headline the dashboard's comparison page
opens with (the baseline is `runIdA`/`sourceA`, the candidate `runIdB`/`sourceB`): a
`title` such as "The candidate finished 9.9s faster than the baseline (37%)", or a failed-job
headline when either run had jobs fail, a `tone` (`better`, `worse`, `same` or
`unknown`), and `sentences` naming which cost metrics and finding categories
moved each way. When either log has no `ApplicationEnd` event, the title
compares how much run time each log covers ("The candidate's log covers 2.0s less run
time than the baseline's") and the tone is `unknown`.

Parameters:

- `runIdA` / `sourceA`: identify the baseline (same `source` shape as above)
- `runIdB` / `sourceB`: identify the candidate
- `redact`: `boolean` (default `false`), pseudonymizes any app id or host/IP
  tokens embedded in free text (stage names and similar) in the response: see
  the note at the top of this page
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

Each side needs either a `runId` or a `source`, and you can mix them: a
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

Example response (`metricDeltas` trimmed to its first row of 11):

```json
{
  "runIdA": "aaaa1111-...",
  "runIdB": "bbbb2222-...",
  "verdict": { "title": "The candidate finished 1.0s faster than the baseline (50%)", "tone": "better", "sentences": [] },
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

Each `findingsDelta.introduced`/`resolved` row is
`{ rule, type, impactBand, baseCount, candCount, delta, stages }`, with
`stages` naming the affected stages. A `metricDeltas` row's `direction` is
`improvement`, `regression`, `unchanged`, `neutral` (a volume metric, where
more isn't worse) or `unavailable`, and an unavailable row carries an
`unavailableReason`. `confidence` is `low` when the two runs' names differ or
under 50% of stages matched between them (`matchedCoverage`), and `reason`
then says which.

## `get_finding_evidence`

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
    "actionLabel": "incomplete run",
    "impactEstimate": { "basis": "informational", "wallClock": null, "estimateMethod": "none" }
  }
}
```

## `get_finding_documentation`

Detection and tuning reference documentation for one finding type,
independent of any run: fetch it once per type (not once per finding) and
cache it.

Parameters:

- `type`: `string` (required): a finding `type` value, e.g. `"skew"`, or a
  detector-level type such as `"broadcastSizing"`, which returns the
  documentation of the finding types it emits

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
    "title": "Task Skew",
    "content": "# Task Skew\n\n..."
  }
}
```

`tuningDoc` is `null` when the finding type has no vendored tuning-doc page.
Two types have none: `configAudit` (its four audited
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
  "title": "Task Skew",
  "content": "# Task Skew\n\n..."
}
```

The returned `anchor` is the owning page's, which can differ from the one you
passed: `"#metric-task-duration"` returns the Metrics Glossary page with
`"anchor": "metrics"`.

An anchor that resolves to no known page returns the `invalid-anchor` error
code (see Errors below).

## `list_runs`

List candidate Spark event-log runs from a local directory or a Spark
History Server, before diagnosing one with the tools above. Local-mode
scanning is non-recursive: only the files and rolling-log subdirectories
directly inside `dir` are considered. Runs are listed newest first.

Parameters:

- `dir` (string, local mode) or `shsBaseUrl` (string, SHS mode): exactly
  one of the two. Passing both fails input validation; passing neither
  returns `access-or-upstream-failure`.
- `namePattern` (string, optional): case-insensitive substring match against
  each run's name.
- `minDate`/`maxDate` (string, optional): filter by start time. A value
  that doesn't parse as a date fails with `invalid-date-filter`. In History
  Server mode the dates are also sent to the server, which may reject an
  unparseable value first (`access-or-upstream-failure`).
- `maxResults` (number, optional, default 100): caps the number of runs
  returned; when more candidates matched, `truncated` is `true`.
- `redact` (boolean, optional, default `false`): pseudonymizes every run's
  app id, name and `source` (see the note at the top of this page).

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
without re-deriving anything, unless `redact` is on: redaction replaces
`source.path` (or `source.appId`) with the pseudonym, so a redacted row can't
be loaded. A row can also carry `durationMs` (History Server mode only) and
`source.attemptId`.

## Errors

Errors a tool raises carry `structuredContent.code`, the same way in all
eight tools:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "<error message>" }],
  "structuredContent": { "code": "<error-code>" }
}
```

Arguments that fail the input schema (a wrong type, a missing required
field, both `dir` and `shsBaseUrl`, `maxResults` below 1) return
`isError: true` with the text `MCP error -32602: Input validation error: ...`
and no `structuredContent`.

The codes:

- `run-not-found`: no cached run for the `runId` you passed.
- `finding-not-found`: that `findingId` isn't on that run.
- `invalid-date-filter`: `list_runs`'s `minDate` or `maxDate` isn't a
  parseable date.
- `invalid-type`: that finding `type` isn't one `get_finding_documentation` recognizes.
- `invalid-anchor`: that `anchor` doesn't resolve to a known `get_reference_doc` page.
- `invalid-event-log`: the file doesn't exist, the file isn't a decodable
  event log, the folder isn't a rolling event-log directory, or the History
  Server archive couldn't be decoded.
- `application-not-found`: the History Server returned a 404 for that
  `appId`/`attemptId`.
- `upstream-unreachable`: loading a run from the History Server failed
  because the server couldn't be reached (connection refused, DNS failure),
  didn't send headers in time, or stalled mid-body. `list_runs` reports it
  when the server can't be reached or doesn't answer in time.
  `SPARKFORENSICS_SHS_TIMEOUT_MS` (default 30000) sets these timeouts. If the
  server is unreachable entirely (an SSH-only cluster), see
  [Behind an SSH bastion](./alternative-log-retrieval.md#behind-an-ssh-bastion).
- `archive-too-large`: the History Server archive blew the byte cap (1 GiB
  by default). Override it with `SPARKFORENSICS_MAX_ARCHIVE_BYTES`.
- `directory-not-found`: `list_runs`'s `dir` doesn't exist, isn't a
  directory, or isn't readable.
- `invalid-shs-base-url`: `list_runs`'s `shsBaseUrl` isn't an absolute
  HTTP(S) URL without credentials, query, or fragment.
- `access-or-upstream-failure`: the fallback code. Bad parameters, a failed
  History Server fetch, or any error that carries no more specific code.
  Common causes: neither `source` nor `runId` given, neither `dir` nor
  `shsBaseUrl` given, `regressionMetric` without `maxRegressionPct`, and a
  `source` whose `shsBaseUrl` or `appId` isn't valid.
