# `diagnose_run`

Reference for the `diagnose_run` tool of the SparkForensics MCP server.

Diagnose a Spark run: thresholded findings, led by the same verdict the
dashboard opens with. `verdict` gives a `title` ("Start with
Stage 3", "1 of 3 jobs failed in this run"), `summary` sentences, `steps`, the
first three places to look in the dashboard's order (each with its action, what
to try, the potential savings and what that figure counts, the other
finding types flagged at the same place, and `leadFinding`, the row of the
finding that leads the step), `costSteps`, the same places ranked by the
measured busy core time a fix removes (only findings that carry one), `idle`, the
core-hours and share of the allocation that ran no task, `remainingPlaces`, how many more
places the full list holds, and `copyText`, the dashboard's "Copy next steps"
checklist. A `summary` sentence such as "3 findings in 2 places." counts the
findings worth fixing. When the run also has notes on an incomplete log or on data
the log lacked, the sentence says the count leaves them out.

The response names the run and the build that wrote it: `app` (the Spark
application's `id` and `attemptId`, `null` when the log has none) and `generator`
(the `sparkforensics-mcp` package `name` and `version`, and the `buildId` of its
analysis core). Two diagnoses of one job are comparable when `generator.buildId`
matches. `runId` is a handle for the run this server process has cached. It differs
per tool by design (`compare_runs` returns `runIdA` and `runIdB`, `evaluate_budgets`
the `runId` of its first run) and per server process, so match runs by `app.id` and
`app.attemptId`.

The answer has two views. `compact` (the default) is an index: the verdict,
`recommendations`, `metrics`, `writeTargets`, `effectiveConf` and one short row
per finding, with no `cleanChecks` or `notRunChecks`. A compact row holds `id`,
`key`, `type`, `tag`, `name`, `impactBand`, `stageId`, `actionLabel`, `metric`,
`value` (or `valueText`), `impact` and `impactMeaning` when the finding has a
savings figure, and `tunedThresholds` on a tuned server. Pass the row's `id` to
[`get_finding_evidence`](./get-finding-evidence.md) for its remediation text,
evidence and estimate. `full` returns every finding as the CLI report
writes it, with `cleanChecks` and `notRunChecks`. The `view` field of the
response names the view. On the bundled sample run the compact answer is about
40% smaller than the full one.

Each finding row has a `key` that is the same for the same finding in a rerun
of the job: the finding's type, its rule and where it sits. A finding on a stage
names the stage by the fingerprint that keys `metrics.stages`, so a row joins to
its stage's metrics without a lookup. A finding on a SQL execution names it by a
digest of its stages' fingerprints, and a configuration finding by the property.
The key pairs findings across runs. It is not unique (a detector that fires once
per host at one place gives rows that share it) and it says nothing about
whether the finding's value or impact band stayed the same. The rows of
[`compare_runs`](./compare-runs.md) list the same keys. `id` stays the handle
within one run.

The response also carries the three machine-readable blocks of the CLI's JSON
report, with the same content: `writeTargets` (every SQL write with its path or
table, see [Write targets](../getting-started/ci-and-automation.md#write-targets)), `metrics`
(run totals and one row per stage, see
[Metrics block](../getting-started/ci-and-automation.md#metrics-block)) and `effectiveConf` (the Spark
properties the run started with, `null` when the log records none, see
[Effective conf](../getting-started/ci-and-automation.md#effective-conf)). With `redact` they are
built from the redacted run, as in the CLI. The tool has no counterpart of
the CLI's `--conf-keys` and `--conf-redact-regex`: `effectiveConf` always lists
every property, withholding Spark's default secret pattern and the job's own
`spark.redaction.regex`.

Parameters (all optional, but pass either a `source` to load a fresh run, or
a `runId` for one already loaded in this session; passing neither is an
error, and when both are given `runId` wins):

- `source`: `{ path: string }` or `{ shsBaseUrl: string, appId: string, attemptId?: string }`.
  A History Server `appId` must have one of Spark's id forms
  (`application_<digits>_<digits>`, `local-<digits>`, `app-...`, `spark-...`,
  `driver-<digits>`).
- `runId`: `string`
- `view`: `"compact" | "full"` (default `"compact"`), see above
- `redact`: `boolean` (default `false`), pseudonymizes the app id, host
  names and user names in the response, and replaces the app name with the
  app id's pseudonym. See [What `--redact` covers](../getting-started/ci-and-automation.md#what-redact-covers)
- `include`: array of `"summary" | "evidenceAvailability" | "detectors"`
  (default omitted, i.e. none). Each requested value adds one extra top-level
  field to the response, on top of the default `verdict`/`findings`/`recommendations`/
  `runComplete`/`writeTargets`/`generator`/`app`/`metrics`/`effectiveConf` (and `cleanChecks`/`notRunChecks`
  in the `full` view):
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
- `impactBand`: array of impact bands (`"critical"`, `"warning"`, `"info"`, e.g.
  `["critical", "warning"]`), narrows the `findings` array to only these bands
- `type`: array of finding `type` values, narrows `findings` to only these
  types. A value that is not a finding type fails schema validation.
- `stageId`: non-negative integer, narrows `findings` to only findings on this stage,
  including a SQL plan finding whose only stage it is (the dashboard's stage
  details rule)
- `minBand`: `"critical" | "warning" | "info"`, lists only findings at this
  band or a more severe one
- `maxFindings`: non-negative integer, lists at most this many findings after
  every other filter, most severe first. `findingsOmitted` counts the
  matching findings the limit left out (always present, `0` when none).
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. With `"md"`, `structuredContent`
  is a small object instead of the report: `runId`, `runComplete`, `title` (the
  verdict's), `findingCount`, `findingsOmitted` and `recommendationCount`. A
  client that stores `structuredContent` stores only those.

`impactBand`/`type`/`stageId`/`minBand`/`maxFindings` only limit the `findings` array
(and the findings section of the Markdown):
`verdict`, `recommendations`, `cleanChecks`, `notRunChecks`, and the finding counts in `summary` (when
requested via `include`) always stay computed from the full, unfiltered set,
so a narrow filter never hides that other checks passed or other fixes exist.
Each verdict step keeps its `leadFinding` row whatever the limit, so the rows the
verdict points at are always in the answer.

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

Example response in the `compact` view (an event log with no `ApplicationEnd`
event; fields trimmed: `verdict`, `recommendations`, `metrics`, `writeTargets`,
`effectiveConf` and the other findings are left out):

```json
{
  "runId": "b8b2c1a4-...",
  "view": "compact",
  "generator": { "name": "sparkforensics-mcp", "version": "0.9.0", "buildId": "9c1f3a7e2b4d" },
  "app": { "id": "application_0000000000000_0001", "attemptId": null },
  "runComplete": false,
  "findingsOmitted": 0,
  "findings": [
    {
      "id": "1d473001",
      "key": "incompleteRun|incompleteRun|run",
      "type": "incompleteRun",
      "name": "Incomplete Run",
      "tag": "INCMP",
      "impactBand": "warning",
      "stageId": null,
      "actionLabel": "incomplete run",
      "metric": "applicationEnd",
      "value": null,
      "valueText": "missing"
    }
  ]
}
```

The same finding in the `full` view (the other fields of the response are left out):

```json
{
  "findings": [
    {
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
  ]
}
```

The figure that drove a finding is in the row's `metric` and `value` (or `valueText`).
In the `full` view `evidence` holds type-specific extra fields and is empty for several types,
such as `incompleteRun` above and `skew`.
