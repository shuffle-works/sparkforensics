# Testing & verification

Before opening a PR:

1. Run the full suite: `npm test` (root), plus `npm run test:core`,
   `npm run test:cli`, `npm run test:mcp` and `npm run test:server` for the
   packages you touched. Each of those four packages has its own Vitest
   config and suite, none of them covered by the root `npm test`. Run
   `npm run build` first on a fresh checkout: `tests/vite-entry.test.js`
   checks the production bundle in `dist/`.
2. Typecheck: `npx tsc --noEmit`.
3. Lint: `npm run lint`. A pre-commit hook (`.githooks/pre-commit`) runs
   eslint on staged `.js`/`.mjs` files only, so run the full lint yourself
   before committing. Neither lints `.ts`/`.tsx` (see `eslint.config.js`):
   `tsc` is their only check.
4. For any UI change, verify it in a real browser (Playwright or headless
   Chrome). Unit and jsdom tests check code correctness; they don't prove a
   feature works end-to-end. Drive the app, exercise the golden path and the
   edge cases, and look for regressions elsewhere on the dashboard.
5. Report the passing test count when you're done, not "tests pass."

Sample Spark event logs for manual testing live outside this repo. Keep them
in a sibling `../spark-log-examples/` directory: real `.zstd` event logs plus
several pairs of baseline and candidate logs for run comparison. They are
private and this repo is public: never put their file names, app IDs, app
names, tables or paths in tracked files, commits or PR text. Use the neutral `private-log-NN` labels under
[Test fixtures](#test-fixtures), and synthetic IDs such as
`application_0000000000000_0001`.

## Testing layout

Vitest throughout. Core logic tests (`packages/core/test/*.test.js`,
covering parser, analyzer, detectors, format-utils, etc.) run under Node via
`npm run test:core`. The root `npm test` runs two environments in one run:
root-level tooling tests (`tests/*.test.js`, `tests/*.test.ts`) and pure
view-logic tests (`tests/view/*.test.ts`) under Node, and component tests
(`tests/view/*.test.tsx`), which declare
`// @vitest-environment jsdom` and use React Testing Library
(`render`/`screen`/`userEvent`). Mount components through React Testing
Library, not hand-rolled DOM code.

`packages/cli`, `packages/mcp` and `packages/server` are separate npm
packages, each with its own Vitest config and suite, not run by the root
suite. Each has a pack-and-spawn test (for example
`packages/server/test/bin.test.js`) that packs and installs the real
published tarball and spawns the real `.bin` entry point, exercising the
production build end-to-end.

`npm run test:e2e` (`e2e/`) drives the production build in Playwright Chromium
through the local server. It needs `npm run build` and
`npx playwright install chromium`, and fails on any request outside the page's
origin or any Content-Security-Policy violation.

`npm run test:core`, `test:cli` and `test:mcp` run with v8 coverage; CI
uploads every suite's lcov to Coveralls. No coverage threshold is enforced
(see the comment in `vitest.config.js`).

Two checks guard invariants that a future edit could silently break. The
`detector contract` suite in `packages/core/test/analyzer.test.js` asserts
every `DETECTORS` entry's contract fields, that `detectorInfoByType` covers
exactly the emitted types, that each entry's thresholds are frozen, and that
the only `suppressedBy` pair is `stageSlowness` -> `slowHost`, both
stage-scope (see
[Cross-detector suppression](./architecture/detector-contract.md#cross-detector-suppression);
declaration order does not matter).
`REGISTRY` and `FINDING_PRESENTATION` completeness is a compile-time check,
not a test: both are typed against the emitted `FindingType` union, so
`npx tsc --noEmit` fails on a missing or extra key (see
[Detector contract](./architecture/detector-contract.md#detector-contract)).

## Test fixtures

Real Spark event logs from private workloads live under `examples/`,
gitignored: they're large, and their file names and contents identify the
jobs that produced them, so they never enter this public repo. Tests, docs and
scripts refer to them only by the neutral labels below. A test that reads one
skips when its file is missing, so the suite passes without any of them. To
run those tests, copy or symlink your own logs into `examples/` under these
names:

| Label | Log it stands for | Used by |
|---|---|---|
| `private-log-01.zstd` | ~12 MB zstd run with Plan Advisor findings | `impact-estimator-real-log.test.js`, `plan-node-stage-mapping-real-log.test.js`, spot-checks in [Impact estimation](./architecture/impact-estimation.md) |
| `private-log-02.zstd` | ~2 MB zstd run with a heavy shuffle-and-spill stage | `plan-node-stage-mapping-real-log.test.js`, spot-checks in [Impact estimation](./architecture/impact-estimation.md) |
| `private-log-03.zstd` | ~28 MB zstd run with about 1,200 stages | timing spot-check in [Impact estimation](./architecture/impact-estimation.md) |
| `private-log-04.zstd` | ~9 MB zstd run whose stage 394 plan became `plan-graph-stage-394.json` | `scripts/extract-plan-fixture.mjs` |
| `private-log-05` | ~76 MB uncompressed NDJSON run, 62 stages | `parser-worker.test.js`; also a fast end-to-end smoke test |
| `private-log-06` | ~1.3 GB uncompressed NDJSON run | `detectors-plan.test.js`; also a stress test for the Web Worker streaming path |
| `private-log-07` | ~120 MB log from a Spark History Server download | none: check the `LZ4Block` codec decoder by hand; `packages/core/test/lz4-block.test.js` uses a small hardcoded byte array instead |

`scripts/extract-plan-fixture.mjs` anonymizes every table, column, path and
literal before it writes the committed fixture; keep it that way if you
extract another one.

Of the finding types `retryWaste`, `autoscalingChurn`, `failures`,
`stageFailed` and `jobFailureRate`, only `retryWaste` and `autoscalingChurn`
fire on any of the real logs in `../spark-log-examples/`. `failures`,
`stageFailed`, and `jobFailureRate` fire on none of them; they are covered
by unit tests only (`tests/view/task-failures.test.tsx`,
`tests/view/stage-failed.test.tsx`, `tests/view/job-failures.test.tsx`), not against a real log.

`dev/log-corpus/` is a git submodule pointing at the public
`spark-event-corpus-data` repo, pinned to a tag. It backs the corpus-backed
tests in `packages/core/test/` (for example `list-runs.test.js`,
`task-failure.test.js`) and `packages/server/test/shs-proxy-fixture.test.js`
(which loads a real `*-parquet-baseline.ndjson` fixture and asserts the
`/shs-proxy` route streams it back unmodified), plus the
[corpus regression snapshot](#corpus-regression-snapshot). Populate it
locally with `git submodule update --init dev/log-corpus`; without it, those
tests skip and the snapshot check has no logs (see
[Development setup](./development-setup.md)). CI's `core`, `server` and
`node18` jobs check it out.

`packages/core/test/fixtures/aqe-skew-spark-3.5.ndjson` and `aqe-skew-spark-4.0.ndjson` are
real local-mode runs (Spark 3.5.9 and 4.0.4) of three queries over 1M rows with 60% on one key,
joined to a 2,000-row table with auto-broadcast off, 16 shuffle partitions, a 2 MB skew
threshold and a 1 MB advisory size set with `spark.conf.set`: an inner join AQE split, a left
outer join with the skew on the right side, and an inner join over `repartition("k")`.
`aqe-skew.test.js` reads them. They were cut down for the repo: `TaskStart` events, the
accumulables of every task but the first of each stage, stage-info details, environment
properties and host names were removed, and the tasks of stages that read no shuffle were dropped.
Regenerate one the same way: run the job with `apache/spark:<version>` in `local[4]` with an
uncompressed, non-rolling event log, and trim it with the same removals.

`packages/core/test/fixtures/synthetic/single-key-shuffle.ndjson` is a hand-made log of one stage
whose nine empty tasks and one 400 MiB task make a single-key shuffle. It sits in a subfolder
because `evidence-panels-not-empty.test.tsx` opens every log directly under `fixtures/`.
`single-key-shuffle.test.js` reads it.

### Corpus regression snapshot

`dev/corpus-snapshot.json` records every finding (type, location, band,
confidence, value, impact estimate) that the detectors produce on each
public corpus log, plus its stage, SQL execution and skipped-line counts,
with timings and memory left out so it is deterministic. CI's `core` job
re-analyzes the corpus and fails on any difference, printing the added,
removed, re-banded and re-estimated findings and changed counts per log:

```bash
node dev/bench-analyze.mjs --check dev/corpus-snapshot.json
```

When a detector, threshold or estimator change is meant to alter findings,
read that diff, confirm each change is the one you intended, then refresh
the snapshot and commit it with the change:

```bash
node dev/bench-analyze.mjs --update dev/corpus-snapshot.json
```

Both default to `dev/log-corpus/logs` and its `external/` folder. A directory
argument expands one level (every regular file, sorted), except a Spark
rolling-log directory (`events_<n>_*` files), which is analyzed as one run. Only
public corpus logs belong in the snapshot: never pass private logs to
`--update`.

### Detector examples

`dev/detector-examples.json` maps every finding type to one public log and the
finding the CLI reports for it. The docs site's detector pages show it as the
example finding card, so every type needs a log that fires it at default
thresholds. Each entry names its `source`, and a type is read from the first
source that fires it:

1. `corpus`: the public logs named in `dev/corpus-snapshot.json`.
2. `fixture`: the recorded logs in `packages/core/test/fixtures`.
3. `synthetic`: the small hand-built logs in
   `packages/core/test/fixtures/synthetic`. A new detector that no recorded log
   fires adds one there, with a test that the real analyzer reports the type
   from it.

Within a source the pick is the best impact band, then the highest confidence,
then the smaller file, then the log name. The finding is the first of that type
in the real CLI's `--redact` JSON, reduced to the fields a page renders. CI's `core` job
regenerates it in memory and fails when it differs:

```bash
node dev/detector-examples.mjs --check
```

After a detector or corpus change that alters it, refresh it and commit the
result with the snapshot:

```bash
node dev/detector-examples.mjs --update
```

Both need the `dev/log-corpus` submodule and say so when it is missing.
`tests/detector-pages.test.js` builds the pages from the committed file, so it
runs without the submodule.

### Detector and estimate tools

Record before and after numbers from these in the commit that changes a
detector, threshold, estimate or the vendored fzstd.

- `node dev/bench-analyze.mjs [--repeat N] --out snap.json <file|dir>...`
  snapshots every finding (band, estimate) plus parse and analyze timings,
  one child process per log. `--diff a.json b.json [--verbose]` shows the
  findings added, removed or re-banded between two snapshots.
- `node --max-old-space-size=12000 dev/eval-tail-replay.mjs [--set detector.threshold=value] [--verbose] <file|dir>...`
  scores skew and straggler against a task-level replay (precision, recall,
  estimate error). `--verbose` lists each miss, false positive and estimate
  more than 2x off. For every stage with 2+ tasks it replays the tasks with
  list scheduling (slots = the stage's observed peak concurrency, tasks in
  launch order) twice: with real durations, and with every task over 4x P50
  capped at P50. A stage is a positive when the difference is at least 0.5% of
  app runtime. The replay is independent of the detectors' own
  `computeTailReplayRecoveryMs`, so it checks that claim.
- `node dev/fuzz-fzstd.mjs --upstream <pristine fzstd esm/index.mjs> <log.zstd>...`
  checks the locally patched `packages/core/src/vendor/fzstd.js` against
  upstream, on whole logs and on randomly corrupted prefixes. Run it after any
  fzstd edit. `--iterations N`, `--seed N` and `--mutations N` tune the random
  cases; it exits 1 when any case differs. Whole-log output must be
  byte-identical, and on corrupted or truncated prefixes the partial output and
  the error must match. The one known difference: a corrupt window size that
  overflows negative throws "Invalid typed array length" at the same byte in
  both, with a different number in the message. Get upstream with
  `npm pack fzstd@0.1.1` and extract `package/esm/index.mjs` (its sha256 is in
  the vendored file's header).
- `node dev/bench-extraction-coverage.mjs [corpus-dir] [--format json] [--strict]`
  reports how much of the corpus's event-log content becomes structured data.
  Each non-blank line of an included event type lands in one bucket:
  `extracted` (known event, passes its schema), `unmodeled` (valid JSON whose
  `Event` is not a modeled one), `schemaFail` (known event that fails its own
  schema, which signals drift against real Spark output) or `malformed` (not
  JSON). `--format json` prints a machine-readable summary and `--strict`
  exits 1 on any `schemaFail`.
- `node dev/bench-event-validation.mjs [fixture-dir]` measures the throughput
  that per-line `SparkEventSchema.safeParse` adds on top of `JSON.parse` on
  the largest fixture, decompressed in memory first.

CI also runs a `node18` job, because the published `cli`, `mcp` and
`server` packages declare `engines.node >=18` while vitest needs Node 22+.
It packs the three tarballs on `.nvmrc`'s Node, installs them on Node 18,
runs the CLI over every corpus log plus a zstd copy of one, checks that the
MCP server answers `initialize`, and starts `sparkforensics-server` to check
it serves the app and answers `initialize` on `/mcp`.

### Benchmarking and output identity

These tools measure a performance change and prove it left the analysis output
alone. The first two need no dependencies beyond Node. `bench-dashboard` uses
Playwright. Run them on a quiet machine (`cat /proc/loadavg`) and report the
load average next to the numbers.

- `node dev/bench-phases.mjs [--repeat N] [--json out.json] <log>[:<baseline>]...`
  times each phase in a fresh `node` child per repeat (cold JIT, as in a real
  CLI run): decompress, collect (parse and model build), findings, evidence
  report, the report's output blocks and, for a `log:baseline` pair, the
  comparison. It prints median, minimum and maximum. `--cli` times the CLI end
  to end, and `--mcp` times the MCP tool functions cold and warm. Prefer the
  in-process phase timers over wall clock when other work shares the machine.
- `node dev/bench-dashboard.mjs [--repeat N] [--json out.json] [--dist dir] [--no-tabs] <log>...`
  drives the production build (`npx vite build` first) in a real browser, one
  fresh context per repeat, and reports the median time from dropping the log
  to the first rendered dashboard, to the point no lazy-widget skeleton is
  left, the main-thread long tasks in between, the JS heap, the peak resident
  memory of the whole browser, and the long tasks of each report-tab switch.
  `--dist` serves another build output, so a
  baseline build copied aside can be interleaved with the branch build.
  `BENCH_BROWSER_CHANNEL=chrome` uses the system Chrome when Playwright's own
  browser is not installed. It starts and stops its own `vite preview`.
- `node dev/bench-graph-layout.mjs [--repeat N] [--top K] [--scope full|segment] <log>...`
  builds each stage's plan graph and times the dagre layout the graph view runs
  for the heaviest ones: a cold layout, then the layout after a duration-mode
  flip (same topology, new node data). A plan whose layout throws is reported as
  such. Logs are labelled by position, not by name.
- `dev/snapshot-cli-output.sh <out-dir> <log>... [-- <baseline>:<candidate>...]`
  writes the CLI's JSON report for every log and a comparison for every pair,
  with the `generator` block removed (its build id hashes the core sources).
  Run it on the base commit and on the branch, then compare:

  ```bash
  dev/snapshot-cli-output.sh /tmp/before dev/log-corpus/logs/*.ndjson
  git switch my-branch
  dev/snapshot-cli-output.sh /tmp/after dev/log-corpus/logs/*.ndjson
  diff -r /tmp/before /tmp/after && echo IDENTICAL
  ```

  State the result and the number of outputs compared in the PR.

## Test-suite growth discipline

Widget and detector test files collect copy-pasted boilerplate fast.
Before adding a widget test file, or a per-widget or per-detector test:

- Cross-cutting widget behavior (impact/stage sort-toggle default and flip,
  density-gated visibility, 6-at-a-time pagination) belongs in a shared
  helper under `tests/view/_shared/`, called from each widget's test file.
  It holds `testFinding` (`finding.ts`), `installInterpretation` and
  the sort-order helpers (`sort-order-toggle.ts`); add a density or
  pagination helper there the first time two widget tests would share one.
  Extract into it only when a test body is identical to an existing one apart
  from the widget name, fixture or label. A widget with a real difference
  (a `React.lazy`-loaded chunk, a custom row finder) keeps its own test.
- `packages/core/test/fixtures/` holds the shared stage and app fixture
  factories (`makeStage`/`makeApp`). Import them instead of pasting a local
  copy into a new core test file.
- Before adding a small test file, check whether a sibling file's `describe`
  block already covers that surface. A detector-catalog shape check, for
  example, belongs in `analyzer.test.js`'s `detector contract` block.
- Calling an exported pure function directly, or calling the documented
  event reducer (`processEvent` in `packages/core/src/event-handlers.ts`,
  re-exported from `parser-worker.ts`; see the
  [worker protocol](./architecture/worker-protocol.md)) with one event and
  inspecting the state, is normal unit testing. Don't rewrite reducer-style
  tests into NDJSON-through-`runParse` integration tests to avoid touching
  internals: that costs readability for no real safety.
