# State and History Server intake

## State model

`src/store/store.ts` is a single Zustand store (`createStore` from
`zustand/vanilla`, wrapped by a `useStore` hook). It holds all shared state; no
component keeps a `useState` of its own for anything shared: `appModel:
AppModel`, `catalog: Finding[]`, `activeFileId`, `sessionCache` (in-memory
snapshot cache for instant file-switching, see `session-snapshot.ts`),
`taskDataCache`, `parse: {pct, lines, etaMs}`, `status:
'idle'|'parsing'|'ready'|'error'`, `errorMessage`, `theme`, `skippedLines`
(malformed-JSON-line count from the parser's `done` payload).

`src/store/useIngest.ts` is the only writer during a parse. It builds
`createModelCallbacks`' `onProgress`/`onDone`/`onError` handlers to call the
store's setters directly (`setParse`, `setCatalog`, `setStatus`,
`setSkippedLines`, ...). Components never talk to the worker: they use
`useIngest()`'s returned actions
(`startLoad`/`startLoadFolder`/`startLoadFromUrl`/`pickRecent`/`getTaskData`/
`resetToDropZone`/`cancelParse`) and the store's read state.
`resetToDropZone` snapshots the current run into `sessionCache` before
resetting; `cancelParse` (the parse screen's **Cancel**) terminates the worker
and never snapshots, so a half-parsed model with no findings can't be restored
later.

`resetModel()` empties `appModel`/`catalog`/`taskDataCache`/`skippedLines` on
every new parse, reset-to-drop-zone or cancelled parse, and bumps
`modelResetCount`. That
counter has no setter of its own; only `PlanGraphRoute.tsx`'s `store.subscribe`
reads it, to evict the plan-graph model memo cache (see
[Plan graph view](./drill-down.md#plan-graph-view)).

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

Recent files (`src/recent-files.ts`, consumed by `src/view/useRecentFiles.ts`)
is IndexedDB-backed and cross-session. It persists each file's
`FileSystemFileHandle` plus light metadata (name, size, `lastModified`, app
name, issue count, `lastOpenedAt`), capped at 10 entries with the oldest evicted
past the cap, so a file can be reopened after a full browser restart, pending
the browser re-granting permission on the handle. Picking a recent entry
re-parses from the handle; no parsed model is ever persisted.

## Run comparison

`src/run-comparison.ts` is the whole A/B engine. The entry point
`compareRuns(baseline, candidate)` takes two `{ label, snapshot }` run records
(each `snapshot` a normalized model: `app`, `stages`, `sql`, `catalog`,
`executors`) and returns one plain object the view renders. It runs on
already-parsed snapshots, with no worker involved.

- `stageIdentity(stage, snapshot)` is a run-independent key: `normalizeStageName`
  (lowercased, digit-runs and long hex ids collapsed to `#`) joined with the
  stage's SQL-execution plan identity. That identity is scoped to only the plan
  nodes this stage's tasks were attributed to (`node.stageIds`), not the whole
  tree, so two stages sharing one SQL execution (e.g. a self-join's two
  Exchange stages) don't collapse onto one identity; it falls back to a
  bottom-up structural fingerprint of the whole resolved `planTree`
  (`planTreeIdentity`, `normalizeDetail`-normalized: the same normalizer
  `cachingOpportunity` uses in `src/detectors.ts`) when a stage has no such
  attribution.
  `matchStages(baseSnap, candSnap)` indexes each run by that identity and pairs
  identities that map to exactly one stage on both sides. An identity colliding
  equally on both sides (same count) is also paired, positionally by sorted
  stage id: exact when comparing a run against itself (every stage matches
  itself), a best-effort guess otherwise (two unrelated same-named stages with
  no SQL/attribution could get cross-paired). Collisions are still recorded in
  `collisionIdentities` even when resolved this way; a differing count leaves
  them there unpaired. `coverage` reports the matched fraction.
- `metricDeltas` computes whole-run aggregate deltas (wall-clock, spill, task
  skew p95, failed-task rate, GC, I/O bytes, executor count, ...) as plain sums
  over all stages, deliberately not gated on stage matching, since matching
  is unreliable on real logs. Each metric carries a `direction`
  (improvement/regression/unchanged) and an `unavailableReason` when a side
  lacks the field.
- `findingsDelta` tallies each run's `catalog` by `(rule × impact band)` and reports
  `introduced` vs `resolved` categories: a count diff, also matching-free.
- Only the per-stage skew deltas (`stageSkewDeltas`) and the pinned-stage panel
  consume the `matchStages` pairs, so low match coverage degrades those two
  surfaces without invalidating the aggregate deltas.

`compareRuns` also flags `confidence: 'low'` when the two app names differ, or
independently when matched stage coverage falls below 0.5 (`LOW_COVERAGE_THRESHOLD`;
either condition alone is enough, both are weak signals, not a hard gate). The view
lives in `src/view/RunComparison.tsx`
(the comparison page), `CompareLanding.tsx` (the two-slot Run A / Run B intake
off the landing), and `PinnedStageDeltas.tsx` (the manual per-stage pinning
panel fed by `baseStages`/`candStages`).

## History Server intake and recovery

`DropZone` keeps the History Server disclosure, Base URL, Application ID,
optional Attempt ID, validation/touched state, recoverable SHS error, and
local-server reachability in mounted React state rather than Zustand. The
local browser-first path is still the default: **Choose file** loads a single
event log, while **Choose rolling-log folder** accepts only an
`eventlog_v2_*` directory and directs a rejected folder back to the file
picker.

The three text fields also mirror to `window.localStorage`
(`shuffle-works-shs-base-url`/`-app-id`/`-attempt-id`), read back as each
`useState`'s initializer, so a returning visitor's values survive a reload;
storage access is wrapped in try/catch and silently ignored when unavailable,
matching `store.ts`'s `initialTheme`/`initialWidgetDensity` pattern. Both this
disclosure's toggle and the **Other sources** toggle show a chevron
(`ChevronDownIcon`/`ChevronUpIcon`) that flips with `aria-expanded`, so the
open/closed state has a visual signal beyond the attribute.

On mount (skipped in `compact` mode), `DropZone` probes reachability with an
empty, short-timeout `fetch('/shs-proxy')`: a 400 means `validateShsRequest`
(`packages/core/src/proxy.js`) rejected the empty request synchronously,
which only happens when a local server is actually routing that path, so it
flips `shsReachable` to `true`. A network error, a 404 (static deploy, no
such route), or a probe still in flight all leave `shsReachable` at its
default `false`, so nothing changes on screen after paint unless the server
is confirmed present. When `shsReachable` is `true`, the landing page shows a
neutral callout above the **Other sources** disclosure pointing the user at
it; the disclosure itself doesn't move or auto-expand.

The collapsed **Fetch from Spark History Server** disclosure requires
local-server mode, a reachable History Server, and a supported base application
ID: `application_<timestamp>_<id>`, `local-<timestamp>`, or
`app-<identifier>`. `packages/core/src/shs-request.js` trims and validates the three
request fields, accepts only absolute credential-free `http:`/`https:` base
URLs without a query or fragment, preserves a reverse-proxy path prefix, and
canonicalizes the base URL to one trailing slash. The optional attempt is a
separate path-safe identifier; neither identifier can contain a path separator.
The shared helper builds the encoded `/shs-proxy` request and the encoded
`api/v1/applications/<app>[/<attempt>]/logs` upstream path from that normalized
object only.

The optional Node server is loopback-only: a narrow CORS proxy, not a
general or hosted proxy. It validates the same request contract, sends no
credentials, follows no upstream redirects, and returns only stable safe error
codes. It never forwards upstream response text, status details, locations, or
credentials to the browser.

Routing preserves the recovery boundary: local file and folder failures use the
existing page-level error route. A typed SHS failure instead resets the model
to idle and returns to the still-mounted, expanded History Server disclosure,
which retains its values and shows safe recovery guidance along with local
file intake. During an SHS parse, the mounted intake shows progress in place;
successful completion follows the normal dashboard route.
