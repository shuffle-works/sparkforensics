# Worker protocol

## Message protocol

Worker to main:

- `app`, `stage`, `sql`, `executor`, `job`, `progress`: progressive, posted as
  the parser reads.
- `sqlPlan` (`{ type: 'sqlPlan', data: { executionId, planTree } }`): posted by
  `endSqlExecution` once a SQL execution's plan tree resolves. A repeated
  `SQLExecutionEnd` for that execution posts nothing, so no later `sql` message
  replaces the entry holding its `planTree`.
- `runAggregates`: one whole-run core-time-series summary (busy-core-ms, peak
  concurrency, per-stage task-duration sums), emitted just before `done`.
- `stageExecutorMetrics`: the post-completion re-post described in
  [Streaming](./overview.md#streaming), also emitted just before `done`.
- `stageSpeculationWaste`: the speculation totals of stages that gained
  waste from a TaskEnd after their StageCompleted, also described in
  [Streaming](./overview.md#streaming) and emitted just before `done`.
- `done`, `taskData`, `error`.

`emitParseCompletion` posts the tail in a fixed order: any deferred AQE `sql`
updates, `progress` (`pct: 1`), `runAggregates`, `stageSpeculationWaste`,
`stageExecutorMetrics`, the terminal `app`, then `done`.

A History Server failure is always the typed payload
`{ type: 'error', source: 'shs', code, message? }`, where `code` is one of
`local-server-unavailable`, `upstream-unreachable`, `application-not-found`,
`access-or-upstream-failure`, or `invalid-event-log`. Fetch and HTTP failures
carry only `code`: never an upstream message, URL, status, or response body.
An `invalid-event-log` from the archive decode can carry a `message` written
by `decodeShsArchive` (`packages/core/src/shs-fetch.ts`): the zip is
unreadable, holds several application attempts or no event log, or an entry
failed to decompress, in which case it names the zip entry and includes the
decoder's error text. The intake shows that message under the recovery text.

Evidence availability has no dedicated worker message: the final `app` message
carries a compact `evidenceInputs` counter summary, and `done.skippedLines`
supplies its parse-integrity input.

Main to worker: `{ type: 'parse', file }`, `{ type: 'parseFiles', files }`
(rolling `eventlog_v2_*` directories, one continuous stream across files),
`{ type: 'parseFromUrl', request }` with `request = { baseUrl, appId, attemptId }`,
and `{ type: 'getTaskData', stageId, reqId }`; `taskData` echoes `stageId` and
`reqId` with `metrics` and `fieldNames`. The SHS request object is normalized
before it reaches the worker:
`{ baseUrl: string, appId: string, attemptId: string | null }`.

Files are read in 512 KiB slices (smaller for small files, so every file gets
at least 100 reads), and `progress { pct, linesProcessed }` posts every 300
lines. `parseFromUrl` reports the download as 0-0.5, then `pct: null` every
2000 lines while parsing.

`taskData` uses structured-clone (`.slice()`) so the worker retains its own
`Float64Array` for re-renders.

Post-parse prefetch: after `done`, main runs `analyzer.ts` to build the
bottleneck catalog, then fires parallel `getTaskData` for every flagged stage
so their widgets render immediately. Unflagged stages are on-demand.

### Decompress worker

A dropped zstd file (`parse`, and each zstd file of a `parseFiles` directory)
is decompressed in a second, nested worker, `packages/core/src/zstd-worker.ts`,
so fzstd and the NDJSON parser run at the same time. The parse worker starts it
on the first zstd file and reuses it for the rest of the parse. It dies with
the parse worker, so the page's `terminate()` also cancels it. Other codecs and
the SHS path (`parseFromUrl`) decompress on the parse worker. A dropped
History Server zip (`parse`) streams its zstd entries through the decompress
worker too.

`packages/core/src/zstd-worker-client.ts` is the parse-worker end: it plugs into
`streamFile` as the `zstdDecoder` option, like the Node CLI's native decoder.
The messages' buffers move by transfer rather than structured-clone copy (a
read slice that is a view of a larger buffer is copied once first, and decoded
output is copied once into a 1 MiB batch):

- Parse to decompress: `start { id }` opens a stream, and replaces any open
  one. `data { id, seq, bytes, final }` carries one compressed read slice.
  `cancel { id }` drops the stream.
- Decompress to parse: `ready` once, at startup. `chunk { id, bytes, length }`
  carries decoded output in batches of up to 1 MiB. `consumed { id, seq }`
  follows the last `chunk` of slice `seq`. `error { id, message }` ends the
  stream, and its message becomes the usual `Could not decompress` error.

Flow control is a window of three input slices: `push()` resolves while fewer
than three slices wait for their `consumed`. Each `chunk` is parsed in its
message handler, so a slice is acknowledged only after its output was parsed,
and at most three slices' output is ever queued. The final `push()` resolves
once every slice is acknowledged. When `streamFile` gives up mid-stream (for
example a failed file read) it calls `cancel()`. A parse exception inside a
`chunk` handler makes the client post `cancel` itself and fail the stream,
which surfaces on the next `push()`.

When the nested worker cannot start (`new Worker` throws or its script fails to
load), the parse worker logs a warning
and decodes with in-thread fzstd, with identical output. A
crash after startup fails the stream it was decoding, and later streams fall
back the same way. The progress
`pct` is the read position, so it can run up to the window ahead of the slice
being parsed. The self-contained `file://` export never parses in the browser
(it opens with its run already analyzed), so it never starts either worker.

### zstd in the browser and in Node

The browser decodes zstd with the vendored fzstd, not `DecompressionStream`. The Node CLI and MCP path (`collectRun`,
`shs-load.ts`) uses `packages/core/src/cli/native-zstd.ts` instead, which walks
frame boundaries itself: Node's own zstd decoders stop after the first frame,
and Spark writes thousands of small ones. A parser change that depends on
chunk shape must hold for both. Native chunks are whole frames, often one full
event line and up to tens of MB (`buildChunkDecoder` decodes those in 512 KiB
slices). For local files, frames of 64 KB or more decompress off the main
thread and arrive as 256 KB pieces, so a native `push()` is async and
`streamFile` awaits it. fzstd's chunks are views of one reused buffer, valid
only until its `ondata` callback returns: copy one before keeping it. On a Node
without native zstd (before 22.15/23.8), and for a frame past 64 MiB, the Node
path falls back to fzstd. The SHS archive loader decodes frames inline, and
only `collectRun` uses the off-thread path.

### Evidence-availability worker input

`packages/core/src/event-handlers.ts`'s `createState()`/per-event handlers start and
increment this fixed `evidenceInputs` shape on the normalized app model:

```text
environmentUpdates, applicationEnds, stageSubmissions, rddStorageSnapshots,
sqlExecutions, resolvedSqlPlans, executorMetricRows, taskRecords
```

The counters are a structured-clone-safe summary: they contain counts, not raw
events, task records, host names, SQL text, paths, or Spark-property values. The final `app` message snapshots the counters after all input is
processed, immediately before `done`; a consumer must not add a second worker
message just for the ledger. `app` messages are also emitted mid-parse from
`SparkListenerApplicationStart`, `SparkListenerApplicationEnd`, and a
`SparkListenerEnvironmentUpdate` that arrives after the start; those
snapshots are partial and non-authoritative. Only the terminal `app` message
emitted by `emitParseCompletion` (the one immediately before `done`) should be
used for evidence-availability conclusions. On the main thread, `useIngest`
combines the normalized `AppModel` with `done.skippedLines`, derives the ledger
before calling `analyze()`, and stores it as `appModel.evidenceAvailability`.

### Evidence-availability contract

`packages/core/src/evidence-availability.ts` is the single reusable taxonomy for the
browser, the evidence report, and the headless CLI and MCP consumers. Its serialized
ledger shape is `{ schemaVersion: 1, entries: EvidenceAvailabilityEntry[] }`.
Entries are ordered by the following fixed eight-key enum:

```text
executorMetrics, rddStorageSnapshots, sqlPlan, sparkConfiguration,
taskCoreTime, infrastructureContext, sourceContext, costContext
```

Each entry has the stable fields `key`, `state`, `reasonCode`, `summary`, and
optional `evidence`. The closed state enum is:

```text
present, disabled, notEmitted, notApplicable, outsideEventLog, unknown
```

The closed reason-code enum is:

```text
observed, explicitlyDisabled, noObservedExecutorMetrics,
noObservedStageSubmission, noRddStorageSnapshot, noResolvedSqlPlan,
noSqlExecution, noEnvironmentUpdate, noTaskRecords, noUsableCoreTimeAggregate,
outsideEventLogScope, parseIncomplete
```

`summary` is domain-agnostic presentation copy derived from the reason code;
the enum values, not labels, are the machine contract. Optional `evidence` is
limited to safe compact provenance of the exact `{ eventType, count }` shape.
`eventType` values are pinned to the exact `evidenceInputs` counter keys; they
are not shortened or aliased.
It must never include raw Spark-property values, host names, paths, SQL text,
task records, raw-event identifiers, or other event payloads.

| Key | Proven `present` evidence | Trustworthy absence / boundary result |
| --- | --- | --- |
| `executorMetrics` | `executorMetricRows > 0` | Explicit observed `spark.eventLog.logStageExecutorMetrics=false` is `disabled` / `explicitlyDisabled`; otherwise `notEmitted` / `noObservedExecutorMetrics`. Observed metrics win over the explicit setting. |
| `rddStorageSnapshots` | `rddStorageSnapshots > 0` from `SparkListenerStageSubmitted` | No stage submissions is `notEmitted` / `noObservedStageSubmission`; stages submitted without any `RDD Info` rows is `notEmitted` / `noRddStorageSnapshot`. This is RDD snapshot evidence, not block-update telemetry. |
| `sqlPlan` | `resolvedSqlPlans > 0` | A SQL execution without a resolved plan is `notEmitted` / `noResolvedSqlPlan`; no SQL execution is `notApplicable` / `noSqlExecution`. |
| `sparkConfiguration` | `environmentUpdates > 0` | `notEmitted` / `noEnvironmentUpdate`; a normalized empty config object alone is not evidence. |
| `taskCoreTime` | `taskRecords > 0` and a usable `runAggregates.perStage` task count | No task records is `notEmitted` / `noTaskRecords`; task records with no usable aggregate are `notEmitted` / `noUsableCoreTimeAggregate`. An empty aggregate object is not usable evidence. |
| `infrastructureContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |
| `sourceContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |
| `costContext` | none | Always `outsideEventLog` / `outsideEventLogScope`. |

Parse integrity is fail-closed. A parse is trustworthy only when it skipped no
malformed lines and observed an application-end event. For an untrustworthy
parse, proof already observed remains `present`, and an explicitly observed
executor-metrics disablement remains `disabled`; every conclusion based on
absence or irrelevance becomes `unknown` / `parseIncomplete`. The three
outside-event-log product boundaries remain `outsideEventLog`. In particular,
`notEmitted` and `notApplicable` are never favorable measurements inferred
from an incomplete parse.

Availability is model metadata, not a detector or finding: it never changes
detector thresholds or ordering, impact band, catalog/scorecard counts,
no-bottleneck behavior, or detector suppression. `session-snapshot.ts`
captures and restores `evidenceAvailability` with the normalized model, so a
recent-file switch retains the same ledger without reparsing.

### Portable evidence report

`packages/core/src/evidence-report.ts`'s `buildEvidenceReport(appModel, { redact })` returns
`{ markdown, json }`: a self-contained, byte-stable document that runs the
detectors over an `appModel` and serializes the result for sharing outside the
tool. Raw task records are never included; identifier redaction (app id + host
names → `app-1`/`host-1` pseudonyms via `packages/core/src/redact.ts`, with the app name
and `spark.app.name` replaced by the app id's pseudonym) is opt-in with
`{ redact: true }`. The JSON is pinned by `EVIDENCE_SCHEMA_VERSION`
(`packages/core/src/evidence-report.ts`, surfaced as `json.schemaVersion`) and has this fixed top-level key order:

```text
schemaVersion, summary, verdict, evidenceAvailability, detectors, findings, recommendations, cleanChecks, notRunChecks
```

- `summary` is the run header: `{ app: { id, name, sparkVersion }, stageCount,
  jobCount, sqlExecutionCount, findingCount, impactBandCounts,
  actionableFindingCount, actionableImpactBandCounts, clean, outcome, runShape }`. `findingCount`
  counts every row in `findings`; the `actionable*` counts leave out evidence
  caveats and the `incompleteRun` row, the same set the dashboard's top bar and
  verdict count. `clean` is `isCleanRun` from `packages/core/src/check-coverage.ts`, and
  `outcome` is `{ failedJobs, totalJobs, failureReason, failureReasonStageId }` from
  `summarizeRunOutcome` (`packages/core/src/run-outcome.ts`), the job results the dashboard
  verdict leads with; the Markdown prints it as an `- Outcome:` header line. `runShape`
  (`computeRunShape`, `packages/core/src/run-shape.ts`) is the Scorecard's wall-clock,
  Efficiency and Unused core time, the ETL phases' summed stage time and Core Usage by
  Locality's peak busy cores, each `null` where the dashboard shows none; MCP
  `get_run_summary` returns it too.
- `verdict` is the dashboard's run verdict from `buildRunVerdict`
  (`packages/core/src/run-verdict.ts`): `{ title, summary, steps, remainingPlaces, copyText }`.
  `steps` holds the first three places to look in the verdict card's order, each
  `{ key, stageId, type, tag, leadFindingId, actionLabel, recommendation, impact, impactMeaning,
  relatedTypes, text }`, where `text` is that step's line of the "Copy next steps" checklist and
  `copyText` is the whole checklist. The Markdown opens with it as `## Verdict`. The
  `recommendations` rollup stays alongside: it ranks fix types, the verdict ranks places.
- `evidenceAvailability` is the ledger above (or `null` when absent).
- `detectors` is `detectorCatalog()` output: one `{ type, version, scope,
  thresholds, docAnchor }` per detector, in `DETECTORS` order, so the exact
  threshold set that produced each finding travels with the evidence. On a
  tuned run (see the tuned-run paragraph below) a tuned row's
  `thresholds` are the ones the run used, plus `tunedThresholds`.
- `findings` are deterministically sorted rows (impact band → type → stage → id),
  each with a stable `id`, `tag`, core columns, an always-present `actionLabel`,
  and an `evidence` sub-object holding that finding type's declared evidence
  fields (see the per-type evidence paragraph below); `confidence`/
  `validationRequired`/`docAnchor` appear only when the detector emitted them.
- `recommendations` is the impact-ranked `buildRecommendationRollup` output
  (`packages/core/src/recommendation-rollup.ts`), and `cleanChecks` lists every detector type
  that fired zero findings this run and could run: see the rollup and clean-checks paragraph below.
- `notRunChecks` lists the zero-finding types the log lacked the data to run, each with a
  `reason`: see the not-run checks paragraph below.

Determinism holds because detector order, finding sort, and object key order
are all fixed, so a given `appModel` serializes identically across calls.

Redaction enumerates hosts two ways: by walking the findings tree for every
string value under a key literally named `host` (`evidence.host`,
`evidence.failedTaskDetails[].host`, `evidence.retriedTaskDetails[].host`,
and any nested `host` field, all covered without enumerating paths),
and by scanning every string value for EC2-style hostnames / bare IPv4
tokens. So identifiers that surface only in free text (recommendation copy, a
`stageFailed` failure reason in `valueText`) are pseudonymized too. Pseudonym numbering
uses a numeric-aware sort, so re-redacting an already-redacted report is a
no-op even past `host-10`.

Failed-task error text is dropped rather than pseudonymized, since a message
or stack trace can carry file paths and data values that no host pattern
matches: every array under a key named `failureGroups` has its `message`
replaced and the message text stripped from its `stackExcerpt`
(`redactTaskFailureGroup` in `task-failure.ts`). That covers the evidence
report and both the findings and the stage records of the HTML export.
A stage's failure reason is replaced outright with `[redacted]` wherever it
appears: a `stageFailed` finding's `valueText`, a stage record's
`stageFailureReason`, a job's `exception` and the report's `failureReason`
(`redactStageFailureReasons` in `redact.ts`).

The Markdown rendering mirrors the JSON's field set: each finding block
prints its `detector version`, its sorted `evidence` entries (byte-magnitude
keys humanized), and the report ends with a `## Detectors` catalog carrying the
version + threshold set. A finding's `impactEstimate` prints as its own `- impact: ` line
worded as the dashboard's "Potential savings": the wall-clock range, or the raw
waste only when there is no range, followed by what it counts ("of run time", "of
unused executor memory") and `estimateMethod`, and nothing for an informational or
zero estimate. A `- estimate: ` line carries the Advanced view's provenance sentence
(`estimateProvenance`). Both come from `packages/core/src/impact-format.ts`, the
formatters every dashboard surface uses, so memory reads in GB-h from 0.1 GB-h up,
core time in core-s or core-h, and a time figure has no "Estimated" prefix. JSON finding
rows carry the same figure as `impact`/`impactMeaning` when there is one, and each
`recommendations` row an `impactMeaning` next to its `impact`, which is null for a
resource figure that rounds to zero. `EvidenceExport` names downloads
`evidence-<appId>[-redacted].<md|json|html>`, taking the app id from the (already
pseudonymized when redacting) report so a redacted file never leaks the real id
and is never name-identical to a raw export.

A finding row carries `impactEstimate` when the finding has one, with the full contract
documented in [Impact estimation](./impact-estimation.md#occupancy-weighted-attribution)
(basis, wallClock, estimateMethod, rawWaste). It appears after the pinned core columns (`id`,
`type`, `impactBand`, `stageId`, `metric`, `value`, `recommendation`, `detectorVersion`, plus
optional but pinned `confidence`, `validationRequired`, `docAnchor`) without displacing any of
them. The full row shape is `FindingRowColumns` in `evidence-report.ts`, which also carries
`name`, `tag`, `valueText`, `actionLabel`, `impact`/`impactMeaning` and, on a tuned run,
`tunedThresholds`.

The report carries the same recommendation data the dashboard's "Fix These First" view shows,
so the CLI (`packages/cli/bin/sparkforensics-analyze.mjs`) and the MCP tool (`diagnoseRun` in
`packages/core/src/mcp-tools.ts`) get it too, not just the web markdown/JSON download.
`FindingRow.actionLabel` is always present (a short imperative label like "Reduce shuffle
size"), from `findingActionLabel` (`packages/core/src/finding-action-label.ts`), which reads the
type's `actionLabel` in `finding-presentation.ts` and falls back to the type's name. The
dashboard, the run verdict and the report rows all call it.
`EvidenceReportJson.recommendations` is the same impact-ranked
`buildRecommendationRollup` grouping (`packages/core/src/recommendation-rollup.ts`) that
`FixTheseFirst.tsx` renders, so CLI/MCP/download consumers get the same "what's the
highest-impact fix" ranking the dashboard shows, without changing the `findings` array's own
impact-band-sorted order at all. `EvidenceReportJson.cleanChecks` lists every
detector type that fired zero findings this run, each with `getThresholdSummary`'s one-line
"what would have tripped it" sentence; unlike the dashboard's `Alerts.tsx` clean-checks table,
it deliberately includes the one "always-mounted" reference type (`coreLocality`) even when it
has no findings, since a flat evidence report has no separate always-visible surface for it to
already appear on the way that widget does on the board.

A check the log could not run is not listed as clean.
`packages/core/src/check-coverage.ts` holds the one rule, shared with the dashboard's verdict,
top bar and Clean checks: a type whose only finding is an evidence caveat, every `scope: 'stage'`
type on a log where no stage recorded an end, and the run-span types (`utilization`,
`memoryUtilization`, `autoscalingChurn`) on a log with no ApplicationEnd. Those types are listed
in `notRunChecks` instead of `cleanChecks`, each `{ type, tag, thresholdSummary, reason }`, where
`reason` is the caveat's own recommendation (it names the setting to turn on) or the log-wide
sentence. The Markdown has a `## Not checked on this log` section above `## Clean checks`, and a
`Findings to act on` header line.

`Finding` is a union discriminated on `type`, one member per emitted
finding type (`packages/core/src/finding-types.ts`), and a finding row's `evidence` is an
explicit per-type projection. Each type's `<Type>Evidence` interface names its public fields,
and `EVIDENCE_KEYS` in `evidence-report.ts` lists the same keys, checked both ways at compile
time, so a field a detector adds only for another core module does not become report contract.
Rows leave out these fields: `stageShape`'s `totalCores`; `utilization`'s `utilizationFraction`,
`appDurationMs` and `totalCores`; `memoryUtilization`'s `idleRateFraction`, `allocatedMB`,
`peakExecutors`, `appDurationMs` and `allocatedBytes`; `retryWaste`'s `extended` display copy.
The impact estimator reads them on the finding. `value` is always numeric or `null`: the
text-valued findings (`stageFailed`'s failure reason, `configAudit`'s current setting,
`incompleteRun`'s `missing`) carry their text in a `valueText` column, present only on those
rows, and the Markdown prints it where `value` would go. Renaming or removing an evidence field
is a breaking change and needs a schema bump. `cleanChecks`/`notRunChecks` list emitted finding
types, the set the dashboard's Clean checks shows: `overBroadcast` and `underBroadcast` in place
of the `broadcastSizing` detector entry. A finding row's `actionLabel` for a (type, discriminant)
combination with no label of its own is the type's name, the same fallback the verdict step
uses.

`buildEvidenceReport(appModel, { thresholds })` runs the detectors
with a user's validated overrides (the CLI's and MCP server's `--thresholds`; see
[Tuning thresholds](./detector-contract.md#tuning-thresholds)). Only a tuned run adds keys:
`tunedThresholds` (`{ <name>: { value, default } }`) on each finding row and each
`cleanChecks`/`notRunChecks` entry from a detector an override moved off its defaults (or
whose `suppressedBy` detector it moved), on that detector's `detectors` row, and as `summary.tunedThresholds` keyed by detector type. The
Markdown adds a `- Tuned thresholds:` header line, a `- tuned thresholds:` line per affected
finding, and marks tuned catalog rows and clean checks. A default run's report carries none of
these keys, and every one is optional. The report caches key on the overrides object as well as
the `appModel`, so one model's default and tuned reports never mix. Finding ids ignore
thresholds: a finding a tuned run still emits keeps the id it has in a default run.

### Finding identity

Every finding `analyzer.ts` emits carries a stable `id` (`push()`'s
`findingId()` choke point, FNV-1a hash over `type | location | metric |
value | discriminators`) and a `detectorVersion` (from the emitting `DETECTORS`
entry). The two are deliberately decoupled: `id` is derived only from a
finding's evidence tuple, never from `detectorVersion`, so a threshold or
logic tweak that bumps a detector's `version` does not change the `id` of
findings it still emits at the same location/metric. A saved reference
(dashboard bookmark, exported report row) keeps
pointing at the same logical finding across detector revisions;
`detectorVersion` is separate provenance metadata for "which ruleset
produced this," not part of identity. See
`packages/core/test/analyzer-finding-identity.test.js` for the decoupling proof.

The discriminators are declared per finding type (`ID_DISCRIMINATORS` in
`analyzer.ts`, each key checked against that type's fields) and joined in the
fixed `DISCRIMINATOR_SLOTS` order, and the value slot takes `value`, else
`valueText`.

`id` stability holds for equivalent reruns of the same schema/analyzer
version on the same input. Changing the id-derivation rule itself (the hash
algorithm, or which fields feed the location key/discriminators) is an
intentional breaking change and must bump `EVIDENCE_SCHEMA_VERSION`
(`packages/core/src/evidence-report.ts`); there is no separate id-scheme version.

### Headless analysis CLI

`packages/cli/bin/sparkforensics-analyze.mjs` runs the same parser + detector contracts outside the
browser, for CI. It accepts a single event-log file or a rolling-log
directory, drives `runParse`/`runParseFiles` (`packages/core/src/parser-worker.ts`) with a
Node-only File-like shim (`nodeFileFromPath` in `packages/core/src/cli/collect-run.ts`), and writes the exact
`buildEvidenceReport` JSON schema described above: one format, not a second.
The shim reads each requested slice with a positioned `readSync`, so a local log is never
loaded whole and has no 2 GiB size limit; `collectRun` closes every descriptor it opened once
parsing settles, on success and on error.
Alternatively, `--shs-base-url <url> --app-id <id> [--attempt-id <id>]` fetches
the run from a Spark History Server instead (mutually exclusive with the
positional file/directory argument), calling `resolveFromShs`
(`packages/core/src/shs-load.ts`, shared with the MCP server's SHS source path below) directly;
no dependency on the `packages/server` package. A failed SHS fetch reports its message
to `stderr` and exits `2`, same as a local file that can't be parsed.

Regression budgets beyond the `--max-regression-pct` pair come from repeated
`--regression-budget <metric>:<pct>` flags and a `--budgets` file, parsed in
`packages/core/src/cli/regression-budgets.ts` and passed to `evaluateBudgets()`
as `regressionBudgets`; the legacy pair is one more budget, and a metric
budgeted twice is a usage error. With two or more positional candidates (or
`--format ndjson`), the CLI's `runMultiLog` parses and analyzes the baseline once,
then evaluates each candidate in turn and writes one NDJSON line per candidate
(`log`, `status`, `exitCode`, `error`, `budgets`, `candidate`, `comparison`). A
candidate that fails to parse gets a `status: "error"` line, counted as
inconclusive (exit `3`); the exit code is the worst line (`2` > `1` > `3` > `0`).

Optional CLI-flag budgets (`--max-runtime <ms>`, `--max-spill <gb>`,
`--max-skew <ratio>`, `--max-failed-task-rate <pct>`, `--min-efficiency <pct>`)
are evaluated in `packages/core/src/cli/budgets.ts` against the existing finding catalog
(`analyze()`) and `computeEfficiencyModel`; there is no second rule engine.
`--min-efficiency` compares `100 - wastagePct` (busy core time, the complement of
the dashboard's Unused core time) and says so in its detail ("Busy core time 26% below
budget 90%."); it is not the Scorecard's Efficiency tile (`stagesActive / total`). A budget
whose required evidence is missing (e.g. the run never emitted
`ApplicationEnd`, or has no usable per-task `runAggregates`) is reported as
inconclusive (`stderr` warning) rather than silently passing, and gets its own
exit code distinct from both pass and violation. Exit codes: `0` pass, `1`
a configured budget was violated, `2` bad arguments (unknown or value-less
flag, unknown `--regression-metric` key), an unreadable or invalid `--thresholds`
file, a failed `--export-html` export, a failed SHS fetch, or input that could not
be parsed at all,
`3` no violations but at least one budget was inconclusive. A violation always
wins over an inconclusive result in the same run (exit `1`, not `3`).
`evaluateBudgets()` also always adds an inconclusive `run-complete` result
when the catalog has an `incompleteRun` finding, so a run with no
`ApplicationEnd` exits `3` even with no budget flags. With `--baseline`, the
absolute budgets and this check apply to the candidate run; the MCP
`evaluate_budgets` tool below uses the same function with the same roles.

### MCP server

`packages/core/src/mcp-server-factory.ts`'s `createMcpServer()` registers 8 tools:
`list_runs` (candidate runs in a local directory or on a Spark History Server, to
pick one before diagnosing it), `diagnose_run` (thresholded findings + remediation text), `get_run_summary`
(app/stage/job/sql counts and duration, no findings), `compare_runs`
(the comparison verdict from `comparisonVerdict` in `packages/core/src/comparison-verdict.ts`,
the dashboard comparison page's own headline, plus categorized findings delta + metric deltas
between two runs; `CompareRunsResult.jobOutcomes` carries each run's failed jobs and incomplete
flag for it),
`evaluate_budgets` (pass/fail budget thresholds against one run, optionally
with a second run for regression/fail-on-introduced budgets: the MCP side
of the CLI's `evaluateBudgets()` gating), `get_finding_evidence` (raw
evidence bundle for one finding, for drill-down after `diagnose_run`),
`get_finding_documentation` (detection/tuning reference docs for one
finding type, independent of any run), and `get_reference_doc` (a full
tuning-reference chapter or bottleneck page by doc anchor, e.g. `#joins`). None
re-implement detector logic: `list_runs` lists candidates
(`packages/core/src/list-runs.ts`), and the rest repackage
`analyze`/`buildEvidenceReport`/`compareRuns`/`captureSnapshot`/`evaluateBudgets`
from `packages/core/src/mcp-tools.ts`, which resolves a `source` (event-log `path`, or an SHS
`shsBaseUrl`/`appId`/`attemptId` triple) into a cached `AppModel`. The SHS
source path calls `resolveFromShs` (`packages/core/src/shs-load.ts`, also used directly by
the CLI's `--shs-base-url` mode above), which reuses two extractions shared
with the browser ingestion flow: `fetchShsEventLog` (`packages/core/src/proxy.js`, the
same upstream fetch the local server's `/shs-proxy` route uses) fetches the zip, and
`decodeShsArchive` (`packages/core/src/shs-fetch.ts`, re-exported from
`parser-worker.ts`'s barrel) streams it through the parser as worker messages, which
`collectViaDispatch` assembles into an `AppModel`. `runParseFromUrl` calls the same
`decodeShsArchive` after fetching through the proxy.

Two transports connect to that one factory: `packages/mcp/bin/sparkforensics-mcp.mjs` (stdio, for
local MCP clients) and `packages/server/index.js`'s `/mcp` route (streamable HTTP, for
the local server). The run cache (`packages/core/src/mcp-tools.ts`) is a module-level LRU
(cap 8 and 15-minute idle TTL by default, overridable via `SPARKFORENSICS_MCP_CACHE_CAP`
and `SPARKFORENSICS_MCP_CACHE_TTL_MS`, lazily swept on access) keyed by resolved source
(path plus mtime, ctime and size, or SHS baseUrl+appId+attemptId), so a client mints a `runId` once
via `resolveOrCreateRun` and reuses it across subsequent tool calls instead of
re-parsing.

Every tool failure comes back as `{isError: true, content: [...],
structuredContent: {code}}`, never an HTTP-status-shaped error; `code` is one
of the 5 existing SHS codes (`SHS_ERROR_CODES`, `packages/core/src/shs-request.js`)
plus `run-not-found`, `finding-not-found`, `invalid-event-log` (also
covers a nonexistent `path` source), `archive-too-large` (SHS archive over
the `SPARKFORENSICS_MAX_ARCHIVE_BYTES` byte cap, default 1 GiB, because the MCP path buffers
the whole archive in memory, unlike the streaming `/shs-proxy` route),
`invalid-type`, `invalid-anchor` (documentation tools), `directory-not-found`,
`invalid-date-filter`, and `invalid-shs-base-url` (`list_runs`). An error without a
code reports `access-or-upstream-failure`. A stalled SHS archive body fails as
`upstream-unreachable` after `SPARKFORENSICS_SHS_TIMEOUT_MS` (default 30 s) without
data.

`scripts/vendor-core.mjs` (shared by `packages/cli`, `packages/mcp`, and
`packages/server`'s `prepack` scripts) vendors `packages/core/src/` wholesale
into each package's own `vendor-core/` at pack time, pre-stripping TypeScript
to plain `.js` (Node's native TS stripping refuses to run on `.ts` files
under `node_modules`, which is exactly where a published `vendor-core/`
lands). Each package's bin/entry point resolves its needed module through
`packages/core/src/load-vendored.js`: from `vendor-core/` if present, else from
the real `packages/core/src/` sibling loaded as `.ts` directly. In a monorepo
checkout a leftover `vendor-core/` is used only while its `core-source-hash.txt`
(written by `vendor-core.mjs`) matches `packages/core/src`; otherwise the bin warns
on stderr and loads `packages/core/src` (`packages/server/index.js` mirrors
`resolveStaticRoot`'s `public/`-vs-`../dist` pattern for this same
fallback).

## TypeScript core and runtime event validation

All of `src/` (browser SPA) and `packages/core/src/` (shared analysis logic)
is strict TypeScript, except for a few plain-`.js` files: the two vendored
third-party decompressors, `packages/core/src/vendor/fflate.js`
and `packages/core/src/vendor/fzstd.js` (left untouched deliberately: vendored code, not
project code), `load-vendored.js` (copied byte-for-byte into `vendor-core/`, so it must
run without TS stripping), and the SHS helpers `shs-request.js` and `proxy.js`, which the
local server imports as plain JS. Every remaining import of a same-repo `.ts` module uses a `.ts`
specifier (e.g. `import { dispatchLine } from './event-handlers.ts'`), not
`.js`: the CLI and MCP entrypoints (`packages/cli/bin/sparkforensics-analyze.mjs`,
`packages/mcp/bin/sparkforensics-mcp.mjs`) run under plain Node's ESM resolver, which
cannot remap a `.js` specifier to a same-named `.ts` file the way Vite/Vitest's
bundler-style resolver can. `tsconfig.json` sets
`"allowImportingTsExtensions": true` to make this legal.

Event schema validation lives in `packages/core/src/event-schemas.ts`: one zod schema per
`SparkListener*` event variant the parser understands (17 total: `LogStart`,
`ApplicationStart`, `EnvironmentUpdate`, `ApplicationEnd`, `JobStart`,
`JobEnd`, `StageSubmitted`, `StageCompleted`, `StageExecutorMetrics`,
`TaskEnd`, the four SQL-execution-UI listener events, `ExecutorAdded`,
`ExecutorRemoved`, `BlockUpdated`), combined into `SparkEventSchema =
z.discriminatedUnion('Event', [...])`. `processEvent`'s switch
(`event-handlers.ts`) consumes the resulting `SparkEvent` union type directly,
so a schema change and a handler's expectations can't silently drift apart.

The recursive `sparkPlanInfo.children` tree carried on SQL-execution-start
events is validated by `parseSparkPlanInfoTree`, an iterative, explicit
heap-allocated-stack parser, deliberately not `z.lazy()`. A real plan tree's
depth is unbounded, and attacker-uncontrolled input should never hand zod's own
recursive schema resolution an arbitrarily deep structure to walk. The
iterative parser shallow-validates one node at a time via `z.object(...)` and
builds the tree itself, capping at `MAX_PLAN_DEPTH = 500` (throws past that).
This mirrors `packages/core/src/plan-tree-walk.ts`'s `walkPlanTree`, which uses the same
iterative-over-recursive approach for the *resolved* tree; `event-schemas.ts`
applies it one layer earlier, to the raw JSON before it becomes a tree at all.

There are two external-data boundaries, the two places this codebase parses
data it does not control. Both run that data through a schema, and both
treat a validation failure the same way: a silent skip, not a distinct error.

- `dispatchLine` (`event-handlers.ts`): after `JSON.parse` succeeds, a line
  whose `Event` value is one of the 17 modeled types but fails that type's own
  schema increments `skippedLines`. An `Event` value outside the 17 modeled
  types is silently ignored without incrementing `skippedLines`: real Spark
  logs always carry plenty of ordinary event types this tool does not model
  (`TaskStart`, `BlockManagerAdded`, `ExecutorMetricsUpdate`, and others), and
  counting them would trip `evidence-availability.ts`'s fail-closed
  `trustworthy` gate on healthy logs. One exception: an AQE update that a later update for the same
  open execution supersedes is never parsed (`deferAdaptiveUpdate`, see
  [the detector contract](./detector-contract.md)), so a malformed
  superseded update is not counted.
- `shs-fetch.ts`: on a non-OK response from the local SHS proxy, the JSON
  error envelope is validated against `ShsProxyErrorBodySchema`
  (`packages/core/src/shs-schemas.ts`, `{ code: string }`, `.passthrough()`). A body that
  isn't valid JSON, or is JSON but fails that schema, falls back to the
  generic `access-or-upstream-failure` code: the same silent-skip treatment
  as a malformed log line. There is no separate "malformed SHS response"
  error code.

Neither boundary distinguishes "malformed JSON" from "wrong shape" from
"unrecognized variant" in what it reports outward: all three collapse into
the same skip/fallback path. That is a deliberate scope decision.

The exhaustiveness convention is `packages/core/src/assert-never.ts`. `assertNever(x: never):
never` throws at runtime and, more importantly, fails `tsc` at compile time if
`x` is not actually `never`, i.e. if some case of a union type isn't handled.
Used at the `default` arm of `event-handlers.ts`'s `processEvent` switch
(over `SparkEvent`) and `analyzer.ts`'s scope-dispatch switch (over a
detector's `scope: 'stage' | 'sql' | 'app' | 'config'`). It is the project's
standard pattern for any future exhaustive switch or dispatch over a closed
union: add `default: return assertNever(x);` (or the closest
non-returning equivalent) so that adding a new union member without updating
every consumer becomes a compile error instead of a silent runtime gap.
