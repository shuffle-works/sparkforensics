# CLI and MCP server

The headless analysis CLI and the MCP server, which run the same parser and detectors outside the browser.

## Headless analysis CLI

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
no dependency on the `packages/server` package. The three flags are checked first with
`validateShsRequest` (`packages/core/src/shs-request.js`), and a malformed one is a usage
error (exit `2`) before any fetch. A failed SHS fetch reports its message
to `stderr` and exits `4`, same as a candidate file that can't be parsed.

Regression budgets beyond the `--max-regression-pct` pair come from repeated
`--regression-budget <metric>:<pct>` flags and a `--budgets` file, parsed in
`packages/core/src/cli/regression-budgets.ts` and passed to `evaluateBudgets()`
as `regressionBudgets`; the legacy pair is one more budget, and a metric
budgeted twice is a usage error. With two or more positional candidates (or
`--format ndjson`), the CLI's `runMultiLog` parses and analyzes the baseline once,
then evaluates each candidate in turn and writes one NDJSON line per candidate
(`log`, `status`, `exitCode`, `error`, `budgets`, `candidate`, `comparison`). A
candidate that can't be read or parsed gets a `status: "error"` line with
`exitCode` `4` (`6` for an internal failure on that candidate); the exit code is
the worst line (`6` > `5` > `4` > `1` > `3` > `0`, `EXIT_SEVERITY`). A baseline
that can't be read exits `5` with no lines. Under
`--redact`, `log` and the `stderr` prefixes are `candidate-<n>` (1-based argument
position) and an error line's message is generic, so no candidate path, which
usually carries the app id, reaches the output. In both modes `--redact` also
swaps the `stderr` text of a baseline or candidate failure (SHS fetch included)
for `redactedFailure`'s role-only message.

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
a configured budget was violated, `2` a usage error (unknown or value-less
flag, unknown `--regression-metric` key, an unreadable or invalid `--thresholds`
or `--budgets` file), `3` no violations but at least one budget was inconclusive,
`4` the candidate could not be read or parsed (or its SHS fetch failed), `5` the
`--baseline` could not be read or parsed, `6` an internal error (an unhandled
failure, a failed `--export-html` export). `main` catches anything unhandled and
exits `6` rather than letting Node exit `1`, which would read as a violation.
When several apply the worst wins: `6`, `5`, `4`, `1`, `3`, `0`; a violation
always wins over an inconclusive result in the same run (exit `1`, not `3`).
`evaluateBudgets()` also always adds an inconclusive `run-complete` result
when the catalog has an `incompleteRun` finding, so a run with no
`ApplicationEnd` exits `3` even with no budget flags. With `--baseline`, the
absolute budgets and this check apply to the candidate run; the MCP
`evaluate_budgets` tool below uses the same function with the same roles.

## MCP server

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

### One output builder for the CLI and MCP

Neither surface lists the fields of a run or a comparison by hand. The CLI's
JSON and the MCP tools call the same core functions:

- `buildComparisonOutput()` in `packages/core/src/comparison-output.ts` diffs the
  two runs, applies `--redact`/`redact` itself (so no surface can budget or
  report an unredacted comparison by skipping it), and returns the redacted
  `CompareRunsResult` for the budget checks and the Markdown renderer, plus
  `comparisonOutput()`'s projection: `verdict`, `confidence`, `reason`,
  `matchedCoverage`, `metrics`, `findings`. That projection is the CLI's
  `comparison` object and the shared part of `compare_runs`. `compare_runs` also
  returns `metricDeltas` and `findingsDelta`, deprecated aliases of `metrics` and
  `findings` kept for one release.
- `runOutputBlocks()` in `packages/core/src/run-output.ts` builds the report's
  `metrics` and `effectiveConf` blocks, redacted from the redacted run, for both
  the CLI report and `diagnose_run`, which also returns the report's `writeTargets`.

Neither surface wraps the other: MCP handlers hold a run cache and report errors
by code, while the CLI maps failures to exit codes and owns stdout. Adding a field
to the projection adds it to both. `packages/cli/test/parity.test.js` runs the CLI's
`main()` and the MCP tools through an in-memory client on public corpus logs,
flattens both outputs and diffs their key sets and values. The differences that
stay (the MCP run handles, the deprecated aliases, the CLI's `schemaVersion`)
are in a commented allowlist in that file, and an entry that explains no
difference fails the test.

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
