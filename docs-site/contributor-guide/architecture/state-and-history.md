# State and History Server intake

## State model

`src/store/store.ts` is a single Zustand store (`createStore` from
`zustand/vanilla`, wrapped by a `useStore` hook). It holds all shared state; no
component keeps a `useState` of its own for anything shared. Run state:
`appModel: AppModel`, `catalog: Finding[]`, `configFindings: Finding[]`,
`interpretation` (see [Run interpretation](#run-interpretation)),
`taskDataCache`, `skippedLines` (malformed-JSON-line count from the parser's
`done` payload). File and parse state: `activeFileId`, `sessionCache`
(in-memory snapshot cache for instant file-switching, see
`packages/core/src/session-snapshot.ts`), `parse: {pct, lines, etaMs}`,
`status: 'idle'|'parsing'|'ready'|'error'`, `shsParsing`, `errorMessage`,
`errorNonce`. View state: `theme`, `widgetDensity`,
`comparison`/`compareLoad`/`compareSeed`, `planGraph`. Export-only:
`exportMode` and `exportProvenance`, both set by `src/export/hydrate-store.ts`.

`src/store/useIngest.ts` is the only writer during a parse. It builds
`createModelCallbacks`' `onProgress`/`onDone`/`onError` handlers to call the
store's setters directly (`setParse`, `setFindings`, `setStatus`,
`setSkippedLines`, `setTaskData`, ...). Components never talk to the worker:
they use `useIngest()`'s returned actions
(`startLoad`/`startLoadFolder`/`startLoadFromUrl`/`pickRecent`/`getTaskData`/
`resetToDropZone`/`cancelParse`, plus the comparison actions
`prepareComparison`/`startCompareLoad`/`compareWithAnotherRun`/`drillIntoRun`)
and the store's read state.
`resetToDropZone` snapshots the current run into `sessionCache` before
resetting; `cancelParse` (the parse screen's **Cancel**) terminates the worker
and never snapshots, so a half-parsed model with no findings can't be restored
later.

`resetModel()` empties the run state (`appModel`, `catalog`,
`configFindings`, `interpretation`, `taskDataCache`, `skippedLines`), returns
`status` to idle, clears `shsParsing` and `errorMessage`, closes any comparison or plan-graph view, and bumps
`modelResetCount`. It runs on every new parse, reset-to-drop-zone, cancelled
parse, typed SHS failure and compare-load parse. That
counter has no setter of its own; only `PlanGraphRoute.tsx`'s `store.subscribe`
reads it, to evict the plan-graph model memo cache (see
[Plan graph view](./drill-down/plan-graph.md#plan-graph-view)).

### Run interpretation

The rule: whatever states a conclusion about this run is computed once by the
producer, whatever responds to what the viewer does is computed live.

`interpretRun` (`packages/core/src/run-interpretation.ts`) is that one
computation; its `RunInterpretation` interface lists what it returns (verdict
and next steps, which checks could not run and why, formatted savings and their
rank, the Scorecard figures and flags, per-stage finding order, the Findings
board's rollup, and per finding type the widget order, doc anchor and
clean-check criterion). It refers to findings by index into
`[...catalog, ...configFindings]`, so a renderer resolves them to the objects it
already holds and reference-identity routing keeps working.

The store's `interpretation` holds that result with the findings it indexes.
The live app fills it from `src/store/live-interpretation.ts`, a
`store.subscribe` installed by `src/main.tsx` (and `tests/view/setup.ts`) that
reinterprets whenever `appModel`, `catalog` or `configFindings` changes.
Widgets read it through `src/view/interpretation.ts`. What stays live responds
to the viewer: filtering, sorting and expanding; the Findings board regrouped
over the findings a filter keeps (`boardRollup`: unfiltered, it renders the
carried groups as is; a time group's recoverable figure is capped by the union
of its members' stage intervals, so a filtered subset cannot be re-totalled
from the carried per-group numbers); and the Scaling Simulator's
`simulateScaling`, a what-if the viewer drives. A widget test that renders one
widget with findings as props installs an interpretation first with
`tests/view/_shared/interpretation.ts`.

Some view judgments sit outside the rule. StageTable's RETRY, fetch-wait,
spill and I/O-ratio chips, PlanView's cross-join, long-filter and exchange-count
warnings, and the plan graph's duration-share heat colours use thresholds in
the view code, with no finding behind them. Do not copy that pattern.

The HTML export carries the same result. `buildHtmlExportData`
(`packages/core/src/html-export.ts`), shared by the CLI's `--export-html` and
the dashboard's download, calls `interpretRun` and writes it into the payload
(`EXPORT_DATA_SCHEMA_VERSION` 3) with a provenance stamp: core version, core
build id (`coreSourceHash` of the core sources: `coreBuildId` in
`load-vendored.js` for the CLI, a Vite `define` for the web build, see
`src/build-info.ts`) and producer, all shown in the export footer. With
redaction on, it redacts the run model and findings first and interprets the
redacted copy, so no text derived from a redacted value (a quoted failure
reason cut mid-host, say) keeps a fragment of it; the md/json report does the
same. The export bundle never installs the live interpreter:
`hydrateExportStore` installs the payload's interpretation as is, and
`src/export/main-export.tsx` refuses, before rendering, any payload whose
`schemaVersion` it was not built for, or that lacks its `configFindings` or
`interpretation` (`unsupportedPayloadReason`). An exported file therefore shows
the conclusions of the core that wrote it, and cannot be reinterpreted by a
later bundle.

What the bundle may import is checked at build time.
`vite.export.config.ts` resolves the live-only modules to stand-ins in
`src/export/live-only-stubs/` (`useIngest`, `useRecentFiles`, `EvidenceExport`,
`core-usage-histogram-data`), whose controls the exported dashboard hides or
replaces with an "isn't included in exported reports" note. Then
`exportAnalysisGuard` (`scripts/export-analysis-guard.mjs`) fails the build if
the graph from `src/export/main-export.tsx` reaches a `packages/core/` module
missing from `ALLOWED_EXPORT_CORE_MODULES`, or any of `LIVE_ONLY_MODULES`,
naming each module and one importer chain back to the entry.
`tests/export-analysis-guard.test.js` runs the real export build
(`--mode guard`) so `npm test` catches a regression. A new core import off the
allowlist fails the build: move its conclusion into `interpretRun`, or, if it
only responds to what the viewer does, add it to the allowlist. The guard
checks modules, not code: a threshold written straight into a widget passes it.

### Finding filter state

The board-wide finding filter (impact band, raw `finding.type`, stage) lives
outside the Zustand store, in `FindingFilterContext`
(`src/view/FindingFilterContext.tsx`): a `createContext`+`useState`
`FilterSelection` (`src/view/finding-filter.ts`, three `Set`s) that every widget
filters `catalog` through via `filterFindings`. It is seeded from the URL's
`impact`/`type`/`stage` query params on mount and nowhere else, so a reload with no
params gives the unfiltered board. Every change writes those params back with
`history.replaceState`, never `push`, so filtering doesn't grow Back history. A
`popstate` listener re-seeds the selection from the URL, so Back and forward
re-apply filters.

Switching files resets the selection to empty, keyed on the stable file id
rather than `catalog`, so a same-file catalog refresh keeps the active filter. A
page reload re-reads the address bar, so deep-linked filtered URLs still
restore. Filters are seeded only from the URL and never persisted anywhere
else (no localStorage, no restore-as-default): a filtered view silently
becoming the default on reload would risk hiding findings from a user who
didn't realize a filter was still active, so a plain reload with no filter
params is always the unfiltered board.

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
