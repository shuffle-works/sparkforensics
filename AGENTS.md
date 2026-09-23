# CLAUDE.md

Spark event-log analyzer: static, zero-backend browser dashboard (optional
local-server deploy mode in `server/`) that parses Spark History NDJSON logs
off the main thread so a 240MB+ task-event stream doesn't freeze Chrome.

## Interaction rules

When the user asks a question or requests advice, DO NOT edit or delete any
files until you have answered and received explicit confirmation to make
changes. Never touch tracked files (e.g., `.gitlab-ci.yml`) while only
answering a question.

## Commands
Test: `npm test` (vitest run; browser SPA + root-level dev tooling only, see below for the other packages)
Watch: `npm run test:watch`
Single file: `npm test -- tests/finding-filter.test.js`
Core package tests: `npm run test:core` (packages/core; detectors, analyzer, parser, MCP tools)
CLI package tests: `npm run test:cli` (packages/cli; pack-and-spawn against the real published tarball)
MCP package tests: `npm run test:mcp` (packages/mcp; pack-and-spawn against the real published tarball)
Server tests: `npm run test:server` (packages/server's own suite; separate deps, not part of `npm test`)
Coverage: `npm run test:coverage` at root or inside any `packages/*` dir runs that package's vitest with `--coverage` (v8 provider, `lcov`+`text` reporters, output at `<pkg>/coverage/lcov.info`); CI's five jobs (`build`/`core`/`cli`/`mcp`/`server`) all route through this and upload to Coveralls via `coverallsapp/github-action`, merged by a final `finish` job.
Dev server: `npm run dev` (Vite)
Build: `npm run build` (runs `docs:build` then `vite build`; outputs `dist/` including `dist/docs/`; `npm run preview` serves it locally)
Typecheck: `npx tsc --noEmit`
Docs site dev: `npm run docs:dev` (VitePress over `docs-site/`)
Docs site build: `npm run docs:build` (fails on dead internal links)
Docs site preview: `npm run docs:preview` (serves the built docs site)
Tuning reference: `npm run docs:bump [-- <sha>]` moves the pinned `shuffle-works/spark-tuning-reference` commit in `packages/core/src/docs-content/upstream.json` (default: upstream head), regenerates the docs and writes the changeset; put the compare link it prints in the PR body. `npm run docs:fetch` makes the generated copy match the pin (no network when it already does). `npm run docs:bump -- --check [<sha>]` runs the anchor gate against upstream head (or `<sha>`) and writes nothing; `.github/workflows/tuning-reference-drift.yml` runs it plus `test:core` weekly.
Analyze (CI): `node packages/cli/bin/sparkforensics-analyze.mjs <file|dir> [--max-runtime ms] [--max-skew ratio] [--max-spill gb] [--max-failed-task-rate pct] [--min-efficiency pct] [--out path] [--format md|json]` (or `--shs-base-url <url> --app-id <id> [--attempt-id <id>]` to fetch from a Spark History Server instead of a local file); also supports baseline regression gating (`--baseline`/`--max-regression-pct`/`--regression-metric`/`--fail-on-introduced`), `--redact`, finding filters (`--impact`/`--type`/`--stage`), and `--export-html <dir>` to write a self-contained `file://`-openable dashboard instead of a md/json report; `--help` for the full flag list.
Detector/estimate tuning: `node dev/bench-analyze.mjs [--repeat N] --out snap.json <file|dir>...` snapshots every finding (band, estimate) plus parse/analyze timings, one child process per log; `--diff a.json b.json [--verbose]` shows added/removed/re-banded findings between two snapshots. `node --max-old-space-size=12000 dev/eval-tail-replay.mjs [--set detector.threshold=value] [--verbose] <file|dir>...` scores skew/straggler against a task-level replay (precision/recall, estimate error); `--verbose` lists each miss, false positive and estimate more than 2x off. `node dev/fuzz-fzstd.mjs --upstream <pristine fzstd esm/index.mjs> <log.zstd>...` checks the locally patched vendored fzstd against upstream, whole logs and randomly corrupted prefixes; run it after any fzstd edit. Record before/after numbers from these in the commit.

The view is React + TypeScript (`src/view/`), built with Vite. The old
zero-build `index.html`-loads-a-plain-script setup is gone: `index.html` is
Vite's entry template (`/src/main.tsx`) and needs `npm run dev` or a build to
run. Manual check: `npm run dev`, drop a file from `examples/`. All of `src/`
(browser SPA) and `packages/core/src/` (shared analysis logic) is strict
TypeScript, including the parser worker
(`packages/core/src/parser-worker.ts`); only the two vendored third-party
decompressors, `packages/core/src/vendor/fflate.js` and
`packages/core/src/vendor/fzstd.js`, remain plain JS. Shared
analysis/detector/parser/MCP-tools logic that used to live alongside the
browser code in `src/` is now `packages/core/`, an npm-workspaces package the
browser SPA depends on via `@sparkforensics/core/*` subpath imports.

Two doc trees, and new content goes in exactly one of them: `docs-site/` is
the published VitePress site, for anything a user or a first-time
contributor should read; `docs/` stays flat internal engineering records
(audits, competitive research), read through GitHub's file viewer.

## Non-Obvious Rules

- The spec/plan/mockup that originally bootstrapped this repo is gone from git
  history: treat `src/` + `tests/` as source of truth, not old doc
  references. Detector/feature ideas often come from other Spark
  log-analysis tools; check whether a "new" bottleneck category already exists
  before proposing one.
- Never commit spec/plan files to this repo (`docs/plans/`, `docs/specs/`,
  `docs/superpowers/specs/`): all three are gitignored. Work them in a
  worktree, implement, then let the file go once the PR merges; don't
  recreate it in-tree afterward and don't paste it into the PR.
- Bottleneck thresholds live in each `packages/core/src/detectors.ts` entry's
  `thresholds` object: spec-fixed values; `packages/core/src/analyzer.ts` is
  just a runner over the `DETECTORS` contract. The full detector roster
  (per-stage: skew, shuffle, spill, GC, failures, slowHost/straggler,
  stageSlowness, partitionSizing, stageShape, stageFailed, retryWaste,
  speculationWaste, tinyTask; app-level: incompleteRun, coldStart,
  utilization, memoryUtilization, cacheUtilization,
  coreLocality, autoscalingChurn, jobFailureRate, cachingOpportunity;
  sql-scope: the Plan Advisor findings duplicatePlanSubtree/smallFiles/
  overBroadcast/underBroadcast (both emitted by the same `DETECTORS` entry,
  headed `broadcastSizing`, which is never itself an emitted finding
  type); config-scope: configAudit) live in
  `docs-site/contributor-guide/architecture/detector-contract.md`, and the
  render sequence in `docs-site/contributor-guide/architecture/widget-rendering.md`:
  read them before adding a detector, changing a threshold, or changing
  rendering order. Some thresholds are
  design-spike/unvalidated and self-flag with a `confidence` marker.
- `analyze()` takes 7 args: `(app, stages, executorsAdded, executorsRemoved,
  jobs, sql, runAggregates)`; `runAggregates` is a whole-run core-time-series
  summary the worker posts before `done`. Cross-detector suppression rides
  `DETECTORS` declaration order (a `suppressWhen` hook in `push()`):
  `stageSlowness` must stay immediately after `slowHost`; a contract test
  asserts the index.
- UI copy must stay domain-agnostic: no company/industry/dataset references
  in rendered output.
- Problem flagging: colored impact dot + ALL-CAPS tag, no emoji, flag every
  affected stage, never just the worst. Current tag vocabulary: `SKEW`, `SHFL`,
  `SPILL`, `GC`, `COLD`, `UTIL`, `MEM` (Memory Utilization), `FAIL` (failed
  tasks), `JOBS` (job-failure rate), `CFG` (config audit), `PLAN` (Plan
  Advisor), `SFAIL` (stage failed outright), `PART` (partition sizing), `SLOW`
  (stage slowness), `SHAPE` (stage shape smells), `CACHE` (caching
  opportunity), `CSTOR` (cache storage), `STRAG` (straggler/speculative tasks), `RETRY` (retry waste),
  `SPEC` (speculation waste), `TINY` (tiny tasks), `LOCAL` (core usage
  locality), `CHRN` (autoscaling churn), `HOST` (slow host), `INCMP`
  (incomplete run). Every widget self-wraps in `WidgetCard` (`src/view/WidgetCard.tsx`),
  which owns the `<h3>` title (one level below the board's `<h2>` section
  headers).
- View layer is React/TypeScript (`src/view/`, shadcn/ui + Tailwind + Recharts):
  no more hand-rolled `html`` `` auto-escaping template or `no-raw-innerhtml`
  guard test; JSX auto-escapes. `packages/core/src/detectors.ts`/
  `packages/core/src/analyzer.ts` and the rest of core are TypeScript too
  (only `packages/core/src/vendor/fflate.js` and
  `packages/core/src/vendor/fzstd.js` remain plain JS), consumed by the view
  unchanged. Finding type → widget component mapping lives in
  `src/view/detector-registry.tsx`'s `REGISTRY`, not a `render:` field on the
  detector entry.
- VitePress installs its own `window`-level, capture-phase click listener
  (`node_modules/vitepress/dist/client/app/router.js`) that intercepts clicks
  on any `<a href="#...">` pointing at the current page and scrolls to the
  target itself, before a theme-added click handler on that same element ever
  runs: calling `preventDefault()` there is too late to stop it. An
  interactive control built over existing in-page anchors (e.g. the
  `docs-site/.vitepress/theme/citation-chips.ts` footnote-marker popovers)
  must drop the element's `href` (restoring `role`/`tabindex`/keyboard
  handling by hand) to keep this interceptor from treating it as a navigable
  link at all.
- `packages/core/src/docs-content/{chapters,tuning,diagrams}` is generated
  (gitignored) from the upstream commit pinned in `upstream.json`, by
  `ensureTuningDocs()` in `scripts/fetch-tuning-docs.mjs`; every consumer
  (`docs:dev`/`docs:build`, `vendor-core.mjs`, both vitest `globalSetup`s,
  `doc-anchor-coverage.js`) calls it first. Never hand-edit it: fix upstream
  and `npm run docs:bump`. Offline or previewing upstream edits:
  `SPARK_TUNING_REFERENCE_DIR=<checkout>`; see
  `docs-site/contributor-guide/development-setup.md`.
- `packages/core/src/docs-content/detection/*.md` is generated from
  `docs-site/user-guide/understanding-findings.md`: after editing that guide run
  `npm run split-detection-docs` and commit the output, or
  `tests/detection-docs-split.test.js` fails.
- zstd decoding differs by runtime: the browser uses the vendored fzstd
  (Chrome has no `DecompressionStream('zstd')`), while the Node CLI/MCP path
  (`collectRun`, `shs-load.ts`) uses `packages/core/src/cli/native-zstd.ts`, which walks frame boundaries
  itself because Node's own zstd decoders stop after the first frame and Spark
  writes thousands of small ones. A parser change that depends on chunk shape
  must hold for both: native chunks are whole frames, often one full event line
  and up to tens of MB (`buildChunkDecoder` decodes those in 512 KiB slices).
  For local files, frames of 64 KB+ decompress off the main thread and arrive
  as 256 KB pieces, so a native `push()` is async and `streamFile` awaits it.
  fzstd's chunks are views of one reused buffer, valid only until its
  `ondata` callback returns: copy one before keeping it.
- Plan summary is best-effort: `summarizePlanTree` (`src/plan-summary.js`) walks
  the resolved `planTree` with lenient regex on each node's `detail`: silently
  omit unparseable fragments, never surface an error. (The old regex
  `plan-extractor.js` over `physicalPlanDescription` was removed.)

## Key documents

- Architecture: [`docs-site/contributor-guide/architecture/index.md`](docs-site/contributor-guide/architecture/index.md)
- Worker protocol: [`docs-site/contributor-guide/architecture/worker-protocol.md`](docs-site/contributor-guide/architecture/worker-protocol.md)
- Widget order: [`docs-site/contributor-guide/architecture/widget-rendering.md`](docs-site/contributor-guide/architecture/widget-rendering.md)
- Impact estimation: [`docs-site/contributor-guide/architecture/impact-estimation.md`](docs-site/contributor-guide/architecture/impact-estimation.md)
- Test fixtures: [`docs-site/contributor-guide/testing.md`](docs-site/contributor-guide/testing.md#test-fixtures)

## Worktree and subagent workflow

Subagents must set and pin their cwd to the isolated worktree, never the main
repo. Verify worktree isolation before starting tasks.

## Testing and verification

Always run the full test suite and verify (in-browser via
playwright/headless-Chrome for UI, or against a real DB for data tools) before
opening a PR or committing; report the passing test count.

### Test-suite growth discipline (non-obvious)

Widget and detector test files accumulate copy-pasted boilerplate fast (a
2026-09 pass trimmed 19 files by a net 272 lines with zero behavior change).
Before adding a new widget test file, or a new per-widget/per-detector test:

- Cross-cutting widget behavior (impact/stage sort-toggle default+flip,
  density-gated visibility, 6-at-a-time pagination) belongs in a shared
  helper under `tests/view/_shared/`, called from each widget's test file:
  don't paste the assertion block again. Only extract into the shared helper
  when a test body is genuinely identical to an existing one modulo
  widget name/fixture/label; a widget with a real difference (e.g. a
  React.lazy-loaded chunk, a custom row-finder) stays as its own separate
  test rather than being force-fit into the shared shape.
- `packages/core/test/fixtures/` holds shared stage/app fixture factories
  (`makeStage`/`makeApp`); import from there instead of re-pasting a local
  copy into a new core test file.
- Before adding a small new test file, check whether a sibling file's
  describe block already covers the same surface (e.g. a detector-catalog
  shape check belongs inside `analyzer.test.js`'s `detector contract`
  describe, not its own file).
- Calling an exported pure function directly in a test, or calling a
  documented event-dispatch reducer (`processEvent` in `parser-worker.ts`,
  see `worker-protocol.md`) with one event and inspecting the resulting
  state, is normal unit testing, not "white-box brittleness." Don't rewrite
  reducer-style tests into full NDJSON-through-`runParse` integration tests
  just to avoid touching internals; that trades readability for a safety
  margin that isn't real.

### Driving the app + PR screenshots (non-obvious)

- Redesigning or prototyping any `src/view/` component: use the
  `capturing-real-component-html` skill instead of guessing at markup: it
  captures the app's own real outerHTML + compiled CSS for the topbar, any
  widget, or the docs site.
- Sample logs: download from a Spark History Server with
  `curl -o app.zip "<baseUrl>/api/v1/applications/<appId>/logs"`: the zip
  holds a `.zstd` eventlog, which is the app's native input format (drop it in
  as-is).
- Real Spark event logs already sit outside the repo in the sibling folder
  `../spark-log-examples/` (native `.zstd` files, drop in as-is). Includes
  several `run-compare-*-baseline-*`/`run-compare-*-candidate-*` pairs for the
  two-run comparison mode.
- `dev/log-corpus` is a git submodule (`spark-event-corpus-data`); it's empty
  until `git submodule update --init dev/log-corpus`. The landing page's "Try
  a sample run" button (`src/view/DropZone.tsx`) fetches a bundled,
  gzip-compressed copy of one of its logs from `public/sample-runs/`: it was
  picked by running `packages/cli/bin/sparkforensics-analyze.mjs --format
  json` over every corpus candidate and taking the one with the most
  findings, not hand-picked. Re-run that scan (or re-run it against new
  corpus commits) before swapping the bundled sample; don't just eyeball a
  log's name.
- Loading a file under playwright: the DropZone prefers `showOpenFilePicker`
  (native dialog, undrivable on localhost Chromium). Force the hidden-input
  fallback with `await page.evaluate(() => delete window.showOpenFilePicker)`
  before clicking **Choose file**, then either `setInputFiles` on
  `[data-testid=file-input]` or handle the `filechooser` event.
- Run comparison starts from the landing: click **Compare two runs** to reveal
  the two slots (**Run A** / **Run B**), fill each slot (force the hidden
  file-input fallback with `await page.evaluate(() => delete window.showOpenFilePicker)`,
  then `setInputFiles` on the slot's `[data-testid=file-input]`), then click
  **Compare**. Both runs parse sequentially through the one worker, then the
  comparison page opens. There is no Topbar **Compare** button anymore; drill
  into a single run with **View run A/B dashboard** and return via **← Back to
  comparison**.
- Embedding screenshots on a PR: the `gh` token can't use the browser-only
  attachment uploader. Instead commit the PNGs to a throwaway asset branch and
  embed them by commit SHA with
  `https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>.png`: the repo
  is public, so every reader's browser loads it (GitHub leaves
  `raw.githubusercontent.com` images un-proxied). Keeps binaries out of the
  feature diff.

## Debugging

Before asserting a root cause, verify it with concrete evidence rather than
inference; state what was checked. If uncertain, say so.


## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
