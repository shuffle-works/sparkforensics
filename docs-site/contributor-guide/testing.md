# Testing & verification

Before opening a PR:

1. Run the full suite: `npm test` (root), plus `npm run test:core`,
   `npm run test:cli`, `npm run test:mcp` and `npm run test:server` for the
   packages you touched. Each of those four packages has its own Vitest
   config and suite, none of them covered by the root `npm test`.
2. Typecheck: `npx tsc --noEmit`.
3. Lint: `npm run lint`. This also runs automatically on every commit via
   `.githooks/pre-commit`, but run it yourself so you catch failures before
   committing.
4. For any UI change, verify it in a real browser (Playwright or headless
   Chrome). Unit and jsdom tests check code correctness; they don't prove a
   feature works end-to-end. Drive the app, exercise the golden path and the
   edge cases, and look for regressions elsewhere on the dashboard.
5. Report the passing test count when you're done, not "tests pass."

Sample Spark event logs for manual testing live outside this repo. Keep them
in a sibling `../spark-log-examples/` directory: real `.zstd` event logs plus
baseline/candidate pairs for run comparison.

## Testing layout

Vitest throughout. Core logic tests (`packages/core/test/*.test.js`,
covering parser, analyzer, detectors, format-utils, etc.) run under Node via
`npm run test:core`. The root `npm test` runs two environments in one run:
root-level tooling tests (`tests/*.test.js`) under Node, and view tests
(`tests/view/*.test.tsx`), which declare
`// @vitest-environment jsdom` and use React Testing Library
(`render`/`screen`/`userEvent`). There are no hand-rolled DOM-mounting jsdom
tests left: the old `tests/widgets/*.test.js` suite called
`src/widgets/*.js`'s `renderX(mount, ...)` functions directly, and every
behavior it covered now has an RTL equivalent.

`packages/cli`, `packages/mcp` and `packages/server` are separate npm
packages, each with its own Vitest config and suite, not run by the root
suite. Each has a pack-and-spawn test (for example
`packages/server/test/bin.test.js`) that packs and installs the real
published tarball and spawns the real `.bin` entry point, exercising the
production build end-to-end.

Two contract tests guard invariants that a future edit could silently break.
The "detector contract" suite in `packages/core/test/analyzer.test.js` asserts
`stageSlowness` stays array-index-after `slowHost` in `DETECTORS` (see
[Detector contract](./architecture/detector-contract.md#detector-contract)).
`tests/view/detector-registry.test.tsx` asserts `REGISTRY` completeness
against every `DETECTORS` type, including the
`underBroadcast`/`overBroadcast` correction: `broadcastSizing` itself is
never an emitted `finding.type`, as the doc comment above `REGISTRY` in
`src/view/detector-registry.tsx` explains.

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

Of the finding types moved onto the Gold Standard row/expand contract in the
widget-gold-standard plan, only `retryWaste` and `autoscalingChurn` fire on
any of the 15 real logs in `../spark-log-examples/`. `failures`,
`stageFailed`, and `jobFailureRate` fire on none of them; they were verified
with unit tests only (`tests/view/task-failures.test.tsx`,
`tests/view/stage-failed.test.tsx`, `tests/view/job-failures.test.tsx`), not against a real log.

`dev/log-corpus/` is a git submodule pointing at the public
`spark-event-corpus-data` repo, pinned to a tag. It backs
`packages/server/test/shs-proxy-fixture.test.js`, which loads a real
`*-parquet-baseline.ndjson` fixture and asserts the `/shs-proxy` route
streams it back unmodified. Populate it locally with
`git submodule update --init dev/log-corpus`; without it, the test suite
skips (see [Development setup](./development-setup.md)). CI checks it out, so
these tests run there.

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

Both default to `dev/log-corpus/logs` and its `external/` folder. Only
public corpus logs belong in the snapshot: never pass private logs to
`--update`.

CI also runs a `node18` job, because the published `cli`, `mcp` and
`server` packages declare `engines.node >=18` while vitest needs Node 22+.
It packs the three tarballs on `.nvmrc`'s Node, installs them on Node 18,
runs the CLI over every corpus log plus a zstd copy of one, checks that the
MCP server answers `initialize`, and starts `sparkforensics-server` to check
it serves the app and answers `initialize` on `/mcp`.
