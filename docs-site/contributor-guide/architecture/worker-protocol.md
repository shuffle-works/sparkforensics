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
- `done`, `taskData`, `error`.

A History Server failure is always the typed, display-safe payload
`{ type: 'error', source: 'shs', code }`, where `code` is one of
`local-server-unavailable`, `upstream-unreachable`, `application-not-found`,
`access-or-upstream-failure`, or `invalid-event-log`. It never carries an
upstream message, URL, status, or response body.

Evidence availability has no dedicated worker message: the final `app` message
carries a compact `evidenceInputs` counter summary, and `done.skippedLines`
supplies its parse-integrity input.

Main to worker: `parse`, `parseFiles(files)` (rolling `eventlog_v2_*`
directories, one continuous stream across files),
`parseFromUrl({ baseUrl, appId, attemptId })`, and `getTaskData(stageId)`. The
SHS request object is normalized before it reaches the worker:
`{ baseUrl: string, appId: string, attemptId: string | null }`.

`taskData` uses structured-clone (`.slice()`) so the worker retains its own
`Float64Array` for re-renders.

Post-parse prefetch: after `done`, main runs `analyzer.ts` to build the
bottleneck catalog, then fires parallel `getTaskData` for every flagged stage
so their widgets render immediately. Unflagged stages are on-demand.

### Decompress worker

A dropped zstd file (`parse`, and each zstd file of a `parseFiles` directory)
is decompressed in a second, nested worker, `packages/core/src/zstd-worker.ts`,
so fzstd and the NDJSON parser run at the same time. On the largest real log,
fzstd had been about 47% of the parse worker's time. The parse worker starts it
on the first zstd file and reuses it for the rest of the parse. It dies with
the parse worker, so the page's `terminate()` also cancels it. Other codecs and
the SHS path (`parseFromUrl`) still decompress on the parse worker. A dropped
History Server zip (`parse`) streams its zstd entries through the decompress
worker too.

`packages/core/src/zstd-worker-client.ts` is the parse-worker end: it plugs into
`streamFile` as the `zstdDecoder` option, like the Node CLI's native decoder.
The messages, all buffers moved by transfer, never copied:

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
once every slice is acknowledged. When `streamFile` gives up mid-stream (a
failed file read, a parse exception), it calls `cancel()`.

When the nested worker cannot start (`new Worker` throws or its script fails to
load), the parse worker logs a warning
and decodes with in-thread fzstd, as it did before, with identical output. A
crash after startup fails the stream it was decoding, and later streams fall
back the same way. The progress
`pct` is the read position, so it can run up to the window ahead of the slice
being parsed. The self-contained `file://` export never parses in the browser
(it opens with its run already analyzed), so it never starts either worker.

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
`SparkListenerApplicationStart` and `SparkListenerEnvironmentUpdate`; those
snapshots are partial and non-authoritative. Only the terminal `app` message
emitted by `emitParseCompletion` (the one immediately before `done`) should be
used for evidence-availability conclusions. On the main thread, `useIngest`
combines the normalized `AppModel` with `done.skippedLines`, derives the ledger
before calling `analyze()`, and stores it as `appModel.evidenceAvailability`.

### Evidence-availability contract (V1)

`packages/core/src/evidence-availability.ts` is the single reusable taxonomy for the
browser, future report output, and future headless consumers. Its serialized
ledger shape is `{ schemaVersion: 1, entries: EvidenceAvailabilityEntry[] }`.
Entries are ordered by the following fixed eight-key enum:

```text
executorMetrics, rddStorageSnapshots, sqlPlan, sparkConfiguration,
taskCoreTime, infrastructureContext, sourceContext, costContext
```

Each entry has the stable fields `key`, `state`, `reasonCode`, `summary`, and
optional `evidence`. The closed V1 state enum is:

```text
present, disabled, notEmitted, notApplicable, outsideEventLog, unknown
```

The closed V1 reason-code enum is:

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

### Portable evidence report (V1)

`packages/core/src/evidence-report.ts`'s `buildEvidenceReport(appModel, { redact })` returns
`{ markdown, json }`: a self-contained, byte-stable document that runs the
detectors over an `appModel` and serializes the result for sharing outside the
tool. Raw task records are never included; identifier redaction (app id + host
names → `app-1`/`host-1` pseudonyms via `packages/core/src/redact.ts`) is opt-in with
`{ redact: true }`. The JSON is pinned by `EVIDENCE_SCHEMA_VERSION` (currently
`3`, surfaced as `json.schemaVersion`) and has this fixed top-level key order:

```text
schemaVersion, summary, evidenceAvailability, detectors, findings, recommendations, cleanChecks
```

- `summary` is the run header: `{ app: { id, name, sparkVersion }, stageCount,
  jobCount, sqlExecutionCount, findingCount, impactBandCounts }`.
- `evidenceAvailability` is the ledger above (or `null` when absent).
- `detectors` is `detectorCatalog()` output: one `{ type, version, scope,
  thresholds, docAnchor }` per detector, in `DETECTORS` order, so the exact
  threshold set that produced each finding travels with the evidence.
- `findings` are deterministically sorted rows (impact band → type → stage → id),
  each with a stable `id`, `tag`, core columns, an always-present `actionLabel`,
  and an `evidence` sub-object for non-core fields; `confidence`/
  `validationRequired`/`docAnchor` appear only when the detector emitted them.
- `recommendations` is the impact-ranked `buildRecommendationRollup` output
  (`packages/core/src/recommendation-rollup.ts`), and `cleanChecks` lists every detector type
  that fired zero findings this run: see the 2026-09-03 update below.

Determinism holds because detector order, finding sort, and object key order
are all fixed, so a given `appModel` serializes identically across calls.

Redaction enumerates hosts two ways: by walking the findings tree for every
string value under a key literally named `host` (`evidence.host`,
`evidence.failedTaskDetails[].host`, `evidence.retriedTaskDetails[].host`,
and any future nested `host` field, all covered without enumerating paths),
and by scanning every string value for EC2-style hostnames / bare IPv4
tokens. So identifiers that surface only in free text (recommendation copy, a
`stageFailed` failure-reason value) are pseudonymized too. Pseudonym numbering
uses a numeric-aware sort, so re-redacting an already-redacted report is a
no-op even past `host-10`.

Failed-task error text is dropped rather than pseudonymized, since a message
or stack trace can carry file paths and data values that no host pattern
matches: every array under a key named `failureGroups` has its `message`
replaced and the message text stripped from its `stackExcerpt`
(`redactTaskFailureGroup` in `task-failure.ts`). That covers the evidence
report and both the findings and the stage records of the HTML export.

The Markdown rendering mirrors the JSON's AC3 field set: each finding block
prints its `detector version`, its sorted `evidence` entries (byte-magnitude
keys humanized), and the report ends with a `## Detectors` catalog carrying the
version + threshold set. A finding's `impactEstimate` (when its `basis` isn't
`'informational'`) prints as its own `- impact: ` line (`Estimated <low>-<high>`
and/or the raw-waste figure, plus `estimateMethod`), via
`renderImpactEstimate`/`formatWallClockRange`/`formatRawWaste` in
`packages/core/src/evidence-report.ts`. `EvidenceExport` names downloads
`evidence-<appId>[-redacted].<md|json>`, taking the app id from the (already
pseudonymized when redacting) report so a redacted file never leaks the real id
and is never name-identical to a raw export.

Decision 9 (design spec): `Finding`'s `impactEstimate` field, plus the
`utilizationFraction`/`memorySize`/`diskSize`/`numCachedPartitions`/`numPartitions`
instrumentation fields the impact estimator reads, were added without bumping
`EVIDENCE_SCHEMA_VERSION` past `1`. Both additions are purely optional and ride
`Finding`'s existing optional-field-plus-catch-all convention, so an evidence report
built before these fields existed still deserializes and compares byte-for-byte against
one built after: nothing about the schema's stability guarantee changed, only its
surface grew. A future reader who notices `impactEstimate` in the JSON without a schema bump is
looking at this deliberate call, not an oversight.

2026-08-30 update: `EVIDENCE_SCHEMA_VERSION` was bumped to `2` for the occupancy-weighted
attribution redesign (see [Occupancy-weighted attribution](./impact-estimation.md#occupancy-weighted-attribution)):
`ImpactEstimate`'s shape changed from `{low, high}` to `{basis, wallClock, estimateMethod,
rawWaste?}`, a real, non-additive breaking change to a field this same Decision 9 previously
shipped without a bump. `impactEstimate` had zero consumers outside `packages/core/src/impact-estimator.ts`
and its own tests at the time of this bump (confirmed by grep across `src/view/*` and
`packages/core/src/evidence-report.ts`), so no other code needed migrating alongside it.

`FindingRow`'s schema was extended to surface `impactEstimate` as a first-class column
without further bumping `EVIDENCE_SCHEMA_VERSION` past `2`, consistent with `Finding`'s
existing optional-field-plus-catch-all convention. It appears after the pinned core
columns (`id`, `type`, `impactBand`, `stageId`, `metric`, `value`, `recommendation`,
`detectorVersion`, plus optional but pinned `confidence`, `validationRequired`, `docAnchor`)
without displacing any of them; byte-for-byte deserializability of existing reports is
preserved. `FindingRow.impactEstimate` carries the full contract documented in
[Impact estimation](./impact-estimation.md#occupancy-weighted-attribution) (basis, wallClock,
estimateMethod, rawWaste).

2026-09-03 update: the "Fix These First" dashboard redesign (impact-ranked recommendation
rollup, short per-finding action labels, a clean-checks table) was UI-only when it shipped;
this update ports the underlying data into `buildEvidenceReport()` so the CLI
(`packages/cli/bin/sparkforensics-analyze.mjs`) and the MCP tool (`diagnoseRun` in `packages/core/src/mcp-tools.ts`) get
it too, not just the web markdown/JSON download. Three additions, all purely additive, so this
does not bump `EVIDENCE_SCHEMA_VERSION` past `2`, the same rationale as the `impactEstimate`
addition immediately above: `FindingRow.actionLabel` is now always present (a short imperative
label like "Reduce shuffle size"), sourced from a new core module,
`packages/core/src/finding-action-label.ts`'s `coreFindingActionLabel`, extracted from the (type,
discriminant) switch statement that used to live only in the view layer
(`src/view/finding-action-label.ts`, which now wraps the core function and layers its own
`REGISTRY` fallback on top). `EvidenceReportJson.recommendations` is the same impact-ranked
`buildRecommendationRollup` grouping (`packages/core/src/recommendation-rollup.ts`) that
`FixTheseFirst.tsx` renders, so CLI/MCP/download consumers get the same "what's the
highest-impact fix" ranking the dashboard shows, without changing the existing `findings`
array's own impact-band-sorted order at all. `EvidenceReportJson.cleanChecks` lists every
detector type that fired zero findings this run, each with `getThresholdSummary`'s one-line
"what would have tripped it" sentence; unlike the dashboard's `Alerts.tsx` clean-checks table,
it deliberately includes the one "always-mounted" reference type (`coreLocality`) even when it
has no findings, since a flat evidence report has no separate always-visible surface for it to
already appear on the way that widget does on the board.

### Finding identity

Every finding `analyzer.ts` emits carries a stable `id` (`push()`'s
`findingId()` choke point, FNV-1a hash over `type | location | metric |
value | discriminators`) and a `detectorVersion` (from the emitting `DETECTORS`
entry). The two are deliberately decoupled: `id` is derived only from a
finding's evidence tuple, never from `detectorVersion`, so a threshold or
logic tweak that bumps a detector's `version` does not change the `id` of
findings it still emits at the same location/metric. A saved reference
(dashboard bookmark, exported report row, future URL-restored filter) keeps
pointing at the same logical finding across detector revisions;
`detectorVersion` is separate provenance metadata for "which ruleset
produced this," not part of identity. See
`packages/core/test/analyzer-finding-identity.test.js` for the decoupling proof.

`id` stability holds for equivalent reruns of the same schema/analyzer
version on the same input. Changing the id-derivation rule itself (the hash
algorithm, or which fields feed the location key/discriminators) is an
intentional breaking change and must bump `EVIDENCE_SCHEMA_VERSION`
(`packages/core/src/evidence-report.ts`); there is no separate id-scheme version.

### Headless analysis CLI (V1)

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

Optional CLI-flag budgets (`--max-runtime <ms>`, `--max-spill <gb>`,
`--max-skew <ratio>`, `--max-failed-task-rate <pct>`, `--min-efficiency <pct>`)
are evaluated in `packages/core/src/cli/budgets.ts` against the existing finding catalog
(`analyze()`) and `computeEfficiencyModel`; there is no second rule engine. A budget
whose required evidence is missing (e.g. the run never emitted
`ApplicationEnd`, or has no usable per-task `runAggregates`) is reported as
inconclusive (`stderr` warning) rather than silently passing, and gets its own
exit code distinct from both pass and violation. Exit codes: `0` pass, `1`
a configured budget was violated, `2` bad arguments (unknown or value-less
flag, unknown `--regression-metric` key) or input that could not be parsed at all,
`3` no violations but at least one budget was inconclusive. A violation always
wins over an inconclusive result in the same run (exit `1`, not `3`).

### MCP server (V1)

`packages/core/src/mcp-server-factory.ts`'s `createMcpServer()` registers 6 tools:
`diagnose_run` (thresholded findings + remediation text), `get_run_summary`
(app/stage/job/sql counts and duration, no findings), `compare_runs`
(categorized findings delta + metric deltas between two runs),
`evaluate_budgets` (pass/fail budget thresholds against one run, optionally
with a second run for regression/fail-on-introduced budgets: the MCP side
of the CLI's `evaluateBudgets()` gating), `get_finding_evidence` (raw
evidence bundle for one finding, for drill-down after `diagnose_run`), and
`get_finding_documentation` (detection/tuning reference docs for one
finding type, independent of any run). None re-implement detector logic;
all repackage
`analyze`/`buildEvidenceReport`/`compareRuns`/`captureSnapshot`/`evaluateBudgets`
from `packages/core/src/mcp-tools.ts`, which resolves a `source` (event-log `path`, or an SHS
`shsBaseUrl`/`appId`/`attemptId` triple) into a cached `AppModel`. The SHS
source path calls `resolveFromShs` (`packages/core/src/shs-load.ts`, also used directly by
the CLI's `--shs-base-url` mode above), which reuses two extractions shared
with the browser ingestion flow: `fetchShsEventLog` (`packages/core/src/proxy.js`)
fetches the zip, and `decodeShsArchive` (`packages/core/src/shs-fetch.ts`, re-exported from
`parser-worker.ts`'s barrel) decodes it into a parsed `AppModel`, the same
split `runParseFromUrl` itself calls into.

Two transports connect to that one factory: `packages/mcp/bin/sparkforensics-mcp.mjs` (stdio, for
local MCP clients) and `packages/server/index.js`'s `/mcp` route (streamable HTTP, for
the local server). The run cache (`packages/core/src/mcp-tools.ts`) is a module-level LRU
(cap 8 and 15-minute idle TTL by default, overridable via `SPARKFORENSICS_MCP_CACHE_CAP`
and `SPARKFORENSICS_MCP_CACHE_TTL_MS`, lazily swept on access) keyed by resolved source
(path mtime, or SHS baseUrl+appId+attemptId), so a client mints a `runId` once
via `resolveOrCreateRun` and reuses it across subsequent tool calls instead of
re-parsing.

Every tool failure comes back as `{isError: true, content: [...],
structuredContent: {code}}`, never an HTTP-status-shaped error; `code` is one
of the 5 existing SHS codes (`SHS_ERROR_CODES`, `packages/core/src/shs-request.js`)
plus `run-not-found`, `finding-not-found`, `invalid-event-log` (also
covers a nonexistent `path` source), and `archive-too-large` (SHS archive over
the `SPARKFORENSICS_MAX_ARCHIVE_BYTES` byte cap, default 1 GiB, because the MCP path buffers
the whole archive in memory, unlike the streaming `/shs-proxy` route).

`scripts/vendor-core.mjs` (shared by `packages/cli`, `packages/mcp`, and
`packages/server`'s `prepack` scripts) vendors `packages/core/src/` wholesale
into each package's own `vendor-core/` at pack time, pre-stripping TypeScript
to plain `.js` (Node's native TS stripping refuses to run on `.ts` files
under `node_modules`, which is exactly where a published `vendor-core/`
lands). Each package's bin/entry point resolves its needed module from
`vendor-core/` if present, else falls back to the real `packages/core/src/`
sibling loaded as `.ts` directly (`packages/server/index.js` mirrors
`resolveStaticRoot`'s `public/`-vs-`../dist` pattern for this same
fallback).

## TypeScript core and runtime event validation

All of `src/` (browser SPA) and `packages/core/src/` (shared analysis logic)
is strict TypeScript; the only plain-`.js` holdouts are the two vendored
third-party decompressors, `packages/core/src/vendor/fflate.js`
and `packages/core/src/vendor/fzstd.js` (left untouched deliberately: vendored code, not
project code). Every remaining import of a same-repo module uses a `.ts`
specifier (e.g. `import { dispatchLine } from './event-handlers.ts'`), not
`.js`: the CLI and MCP entrypoints (`packages/cli/bin/sparkforensics-analyze.mjs`,
`packages/mcp/bin/sparkforensics-mcp.mjs`) run under plain Node's ESM resolver, which
cannot remap a `.js` specifier to a same-named `.ts` file the way Vite/Vitest's
bundler-style resolver can. `tsconfig.json` sets
`"allowImportingTsExtensions": true` to make this legal.

Event schema validation lives in `packages/core/src/event-schemas.ts`: one zod schema per
`SparkListener*` event variant the parser understands (15 total: `LogStart`,
`ApplicationStart`, `EnvironmentUpdate`, `ApplicationEnd`, `JobStart`,
`JobEnd`, `StageSubmitted`, `StageCompleted`, `StageExecutorMetrics`,
`TaskEnd`, the three SQL-execution-UI listener events, `ExecutorAdded`,
`ExecutorRemoved`), combined into `SparkEventSchema =
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
data it does not control. Both now run that data through a schema, and both
treat a validation failure the same way: a silent skip, not a distinct error.

- `dispatchLine` (`event-handlers.ts`): after `JSON.parse` succeeds, a line
  whose `Event` value is one of the 15 modeled types but fails that type's own
  schema now increments `skippedLines` (previously: no shape validation
  existed at all, and a malformed event silently corrupted downstream state
  with no signal anywhere). An `Event` value outside the 15 modeled types is
  still silently ignored without incrementing `skippedLines`, unchanged from
  before migration (see the note below on why the broader design was
  rejected). One exception: an AQE update that a later update for the same
  open execution supersedes is never parsed (`deferAdaptiveUpdate`, see
  [the detector contract](./detector-contract.md)), so a malformed
  superseded update is not counted.
- `shs-fetch.ts`: on a non-OK response from the local SHS proxy, the JSON
  error envelope is validated against `ShsProxyErrorBodySchema`
  (`packages/core/src/shs-schemas.ts`, `{ code: string }`, `.passthrough()`). A body that
  isn't valid JSON, or is JSON but fails that schema, falls back to the
  generic `access-or-upstream-failure` code: the same silent-skip treatment
  as a malformed log line, collapsing what could have been a separate
  "malformed SHS response" error code into the existing generic one.

Neither boundary distinguishes "malformed JSON" from "wrong shape" from
"unrecognized variant" in what it reports outward: all three collapse into
the same skip/fallback path. That was a deliberate scope decision. The
correction below says why the *line* boundary stops there rather than flagging
every unrecognized event type.

> Correction made during migration, not part of the original design: an
> earlier draft counted *any* `Event` value outside the 15 modeled types
> toward `skippedLines`, not just ones that fail their own schema. Running
> that design against real Spark event logs (which always contain plenty of
> ordinary event types this tool has never modeled: `TaskStart`,
> `BlockManagerAdded`, `ExecutorMetricsUpdate`, and others, always silently
> ignored pre-migration) pushed `skippedLines` from 0 to the tens of thousands
> on completely healthy logs. That would have tripped
> `evidence-availability.ts`'s fail-closed `trustworthy` gate and shown a
> false "malformed JSON" warning on every real file. Caught in review against
> real fixtures, not synthetic ones; fixed to the narrower rule described
> above before merging. `evidence-availability.ts`'s gate itself
> (`trustworthy = skippedLines === 0 && applicationEnds > 0`) needed no code
> change once this was fixed: it was already correct, the input feeding it
> was not.

The exhaustiveness convention is `packages/core/src/assert-never.ts`. `assertNever(x: never):
never` throws at runtime and, more importantly, fails `tsc` at compile time if
`x` is not actually `never`, i.e. if some case of a union type isn't handled.
Used today at the `default` arm of `event-handlers.ts`'s `processEvent` switch
(over `SparkEvent`) and `analyzer.ts`'s scope-dispatch switch (over a
detector's `scope: 'stage' | 'sql' | 'app' | 'config'`). It is the project's
standard pattern for any future exhaustive switch or dispatch over a closed
union: add `default: return assertNever(x);` (or the closest
non-returning equivalent) so that adding a new union member without updating
every consumer becomes a compile error instead of a silent runtime gap.
