# State and History Server intake

## State model

`src/store/store.ts` is a single Zustand store (`createStore` from
`zustand/vanilla`, wrapped by a `useStore` hook). It holds all shared state; no
component keeps a `useState` of its own for anything shared. Run state is one
value: `run: AnalyzedRun | null` and its `runKey`, plus `taskDataCache` (the
per-task detail fetched so far). The `AnalyzedRun`
(`packages/core/src/analyzed-run.ts`) holds the parsed `appModel` (with the
evidence ledger, `skippedLines` and `unreadableSqlExecutions`), the detector
`catalog`, the `configFindings`, the `interpretation` (see
[Run interpretation](#run-interpretation)) and a `taskData` source. Views read it
through `selectAppModel`, `selectCatalog` and `selectConfigFindings`, or
`run.interpretation` through `src/view/interpretation.ts`. File and parse state:
`activeFileId`, `sessionCache` (in-memory snapshots, each a `SerializedRun`, for
instant file-switching), `parse: {pct, lines, etaMs}`,
`status: 'idle'|'parsing'|'ready'|'error'`, `shsParsing`, `errorMessage`,
`errorNonce`. View state: `theme`, `widgetDensity`,
`comparison`/`compareLoad`/`compareSeed`, `planGraph`. Export-only:
`exportMode` and `exportProvenance`, both set by `src/export/hydrate-store.ts`.

A run enters the store one way: `installRun(run, runKey)`. It replaces `run` and
`runKey` whole, sets `status` to `ready` and starts `taskDataCache` from the
run's task data. There is no setter for a single run field. `runKey` is the file
id, else a generated `run-N` for a folder or History Server load; `App.tsx`
renders `<DashboardRoute key={runKey} />`, so a new run remounts the dashboard and
every piece of per-run view state (page, sort, open cards, the core-usage
histogram) starts fresh. A view does not reset that state from an effect on
`appModel` or `activeFileId`; the ast-grep rule `no-run-reset-effect` flags one.

A run's `taskData` says where its per-task detail comes from. A live parse
holds `{ kind: 'worker', request }`, and `getTaskData` asks the worker for a
stage the cache lacks. A restored or drilled-into run has no worker: it holds
`{ kind: 'snapshot', stages }`, the stages prefetched before it left the screen,
or `{ kind: 'none' }`. A run read from an export is always `none`. The stage
dialog, the core-usage histogram and the task spread read it through
`useLiveTaskData` and say "isn't available for this run" instead of fetching.

`src/store/useIngest.ts` is the only writer during a parse. Each load builds
into a fresh `AppModel` it owns. On `done` it calls `analyzeRun` (the one place
the detectors, the config audit, the evidence ledger and the interpretation run)
and installs the result. Components never talk to the worker:
they use `useIngest()`'s returned actions
(`startLoad`/`startLoadFolder`/`startLoadFromUrl`/`pickRecent`/`getTaskData`/
`resetToDropZone`/`cancelParse`, plus the comparison actions
`prepareComparison`/`startCompareLoad`/`compareWithAnotherRun`/`drillIntoRun`)
and the store's read state.
`resetToDropZone` snapshots the current run into `sessionCache` with
`serializeRun` before resetting; `pickRecent` and `drillIntoRun` install
`deserializeRun(snapshot)`. `cancelParse` (the parse screen's **Cancel**)
terminates the worker and never snapshots, so a half-parsed model can't be
restored later.

Every parse ends in `ready` or `error`, never in a stuck `parsing`. A throw in
`runDone` before the run is ready (analysis on odd log data) and a throw while
opening a compare operand set `errorMessage`; once the run is `ready`, a failed
task-data prefetch or recent-files write is logged and the dashboard stays.

Render errors stay local. `ErrorBoundary` (`src/view/ErrorBoundary.tsx`) wraps
each grid card in `WidgetGridItem`, so a widget that throws on a log's data
shows an error card with **Retry** while its siblings keep rendering. Picking
another recent run remounts the dashboard, so the new run never shows the
previous run's error.
`AppErrorBoundary` wraps the app routes in `src/App.tsx`: a throw outside a
card, or a lazy chunk that fails to load, shows a page with **Reload page** and
**Load another log** (which runs `cancelParse`).

`resetModel()` clears `run`, `runKey` and `taskDataCache`, returns
`status` to idle, clears `shsParsing` and `errorMessage`, and closes any comparison or plan-graph view.
It runs on every new parse, reset-to-drop-zone, cancelled
parse, typed SHS failure and compare-load parse. The plan-graph model memo cache
is keyed by the run's `appModel`, so a new run never reads a previous run's
models (see [Plan graph view](./drill-down/plan-graph.md#plan-graph-view)).

### Serializing a run

`serializeRun` and `deserializeRun` (`packages/core/src/run-serialization.ts`)
are the one pair that turns an `AnalyzedRun` into plain data and back, for the
session snapshots in `sessionCache` and for the HTML export. `SerializedRun`
lists every field with its collections as arrays, and the `FIELDS` table gives
each one the run or model field it carries and its redaction policy: `redact`
(pseudonymized), `keep` (counts and ids), `derive` (recomputed from the
redacted run) or `drop`. `FIELDS` and the `SerializedRun` type are checked
against `AnalyzedRun` and `AppModel`, so a new field does not compile until it
is serialized and given a policy, and `redactRun` (`packages/core/src/redact.ts`)
follows the table instead of listing fields. `packages/core/test/run-serialization.test.js`
round-trips every fixture log and fails when a run or model field has no entry.

### Run interpretation

The rule: whatever states a conclusion about this run is computed once by the
producer, whatever responds to what the viewer does is computed live.

`interpretRun` (`packages/core/src/run-interpretation.ts`) is that one
computation, and `analyzeRun` calls it, so the interpretation is a field of the
run; its `RunInterpretation` interface lists what it returns (verdict
and next steps, which checks could not run and why, formatted savings and their
rank, the Scorecard figures and flags, per-stage finding order, the Findings
board's rollup, and per finding type the widget order, doc anchor and
clean-check criterion). It refers to findings by their `id`, which is unique
across `catalog` and `configFindings`, so the order the findings are held in
never matters. `src/view/interpretation.ts` resolves the ids to the finding
objects the run holds, so reference-identity routing keeps working.

Widgets read the interpretation through `src/view/interpretation.ts`. What stays live responds
to the viewer: filtering, sorting and expanding; the Findings board regrouped
over the findings a filter keeps (`boardRollup`: unfiltered, it renders the
carried groups as is; a time group's recoverable figure is capped by the union
of its members' stage intervals, so a filtered subset cannot be re-totalled
from the carried per-group numbers); and the Scaling Simulator's
`simulateScaling`, a what-if the viewer drives. A widget test that renders one
widget with findings as props installs a run first with
`tests/view/_shared/interpretation.ts` or `tests/view/_shared/run.ts`.

Some view judgments sit outside the rule. StageTable's RETRY, fetch-wait,
spill and I/O-ratio chips, PlanView's cross-join, long-filter and exchange-count
warnings, and the plan graph's duration-share heat colours use thresholds in
the view code, with no finding behind them. Do not copy that pattern.

The HTML export carries the same result. `buildHtmlExportData`
(`packages/core/src/html-export.ts`), shared by the CLI's `--export-html` and
the dashboard's download, takes the `AnalyzedRun` and writes it as an
`ExportRunData` (`SerializedRun` plus provenance, `EXPORT_DATA_SCHEMA_VERSION` 4;
`taskData` is always null) with a provenance stamp: core version, core
build id (`coreSourceHash` of the core sources: `coreBuildId` in
`load-vendored.js` for the CLI, a Vite `define` for the web build, see
`src/build-info.ts`) and producer, all shown in the export footer. With
redaction on, `redactRun` redacts the run model and findings first and derives
the interpretation from the redacted copy, so no text derived from a redacted value (a quoted failure
reason cut mid-host, say) keeps a fragment of it; the md/json report does the
same. The export bundle never analyzes a run:
`hydrateExportStore` installs the payload's run with `installRun`, interpretation as is.
`src/export/main-export.tsx` refuses, before rendering, any payload whose
`schemaVersion` it was not built for, or that lacks its `configFindings`,
`interpretation`, `stages`, `sql` or `jobs` (`unsupportedPayloadReason`). A
missing or damaged `data.js` (no payload global, truncated gzip, invalid JSON)
gets the same view with a "missing or unreadable" reason: `loadExportPayload`
never throws. An exported file therefore shows
the conclusions of the core that wrote it, and cannot be reinterpreted by a
later bundle.

What the bundle may import is checked at build time.
`vite.export.config.ts` resolves the live-only modules to stand-ins in
`src/export/live-only-stubs/` (`useIngest`, `useRecentFiles`, `EvidenceExport`,
`core-usage-histogram-data`), whose controls the exported dashboard hides or
replaces with an "isn't available for this run" note. Then
`exportAnalysisGuard` (`scripts/export-analysis-guard.mjs`) fails the build if
the graph from `src/export/main-export.tsx` reaches a `packages/core/` module
missing from `ALLOWED_EXPORT_CORE_MODULES`, or any of `LIVE_ONLY_MODULES`,
naming each module and one importer chain back to the entry.
`tests/export-analysis-guard.test.js` runs the real export build
(`--mode guard`) so `npm test` catches a regression. A new core import off the
allowlist fails the build: move its conclusion into `interpretRun`, or, if it
only responds to what the viewer does, add it to the allowlist. The guard
checks modules, not code: a threshold written straight into a widget passes it.
The detector docs pages reuse this graph: `npm run build:docs-widget`
(`--mode docs-widget`) builds the example app `docs-widget.html`, with the same
stand-ins and guard, as multi-file output under `docs-site/public/`.

### Finding filter state

The board-wide finding filter (impact band, raw `finding.type`, stage) lives
outside the Zustand store, in `FindingFilterContext`
(`src/view/FindingFilterContext.tsx`): a `createContext`+`useState`
`FilterSelection` (`src/view/finding-filter.ts`, three `Set`s) that every widget
filters `catalog` through via `filterFindings`. It is seeded from the URL's
`impact`/`type`/`stage` query params on mount and nowhere else, so a reload with no
params gives the default board. A selection that names no impact band lists
critical and warning findings only (`matchesFilter`); info findings show once
the selection names the info band. Every change writes those params back with
`history.replaceState`, never `push`, so filtering doesn't grow Back history. A
`popstate` listener re-seeds the selection from the URL, so Back and forward
re-apply filters.

Switching files resets the selection to empty, keyed on the stable file id. A
page reload re-reads the address bar, so deep-linked filtered URLs still
restore. Filters are seeded only from the URL and never persisted anywhere
else (no localStorage, no restore-as-default): a filtered view silently
becoming the default on reload would risk hiding findings from a user who
didn't realize a filter was still active, so a plain reload with no filter
params is always the default board.

### Recent files vs. session cache

Two mechanisms cover reopening a file, at different lifetimes.

`sessionCache` (in the Zustand store, see [State model](#state-model)) is
in-memory and per-session: it makes switching between files already loaded in
the current tab instant, and it is gone on reload.

Recent files (`packages/core/src/recent-files.ts`, consumed by
`src/view/useRecentFiles.ts`, `DropZone.tsx` and `useIngest.ts`)
is IndexedDB-backed and cross-session. It persists each file's
`FileSystemFileHandle` plus light metadata (name, size, `lastModified`, app
name, issue count, `lastOpenedAt`), capped at 10 entries with the oldest evicted
past the cap, so a file can be reopened after a full browser restart, pending
the browser re-granting permission on the handle. Picking a recent entry
re-parses from the handle; no parsed model is ever persisted.
