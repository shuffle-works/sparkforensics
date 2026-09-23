# Testing & verification

Before opening a PR:

1. Run the full suite: `npm test` (root) and, if you touched `server/`,
   `npm run test:server` too: it's a separate package with its own
   dependencies, not covered by the root suite.
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

Vitest throughout, two environments in one run. Core logic tests
(`tests/*.test.js`, covering parser, analyzer, detectors, format-utils, etc.)
run under Node. View tests (`tests/view/*.test.tsx`) declare
`// @vitest-environment jsdom` and use React Testing Library
(`render`/`screen`/`userEvent`). There are no hand-rolled DOM-mounting jsdom
tests left: the old `tests/widgets/*.test.js` suite called
`src/widgets/*.js`'s `renderX(mount, ...)` functions directly, and every
behavior it covered now has an RTL equivalent.

`server/` is a separate npm package with its own Vitest config and
`npm test`, not run by the root suite. One test there,
`server/test/bin.test.js`, packs and installs the real published tarball and
spawns the real `.bin` entry point: the only test that exercises the
production build end-to-end.

Two contract tests guard invariants that a future edit could silently break.
The "detector contract" suite in `tests/analyzer.test.js` asserts
`stageSlowness` stays array-index-after `slowHost` in `DETECTORS` (see
[Detector contract](./architecture/detector-contract#detector-contract)).
`tests/view/detector-registry.test.tsx` asserts `REGISTRY` completeness
against every `DETECTORS` type, including the
`underBroadcast`/`overBroadcast` correction: `broadcastSizing` itself is
never an emitted `finding.type`, as the doc comment above `REGISTRY` in
`src/view/detector-registry.tsx` explains.

## Test fixtures

Example event logs live under `examples/`. They are real Spark History NDJSON
logs, not text, and gitignored for size.

- `small-application_1777489669889_56601` (~76 MB): fast end-to-end smoke test.
- `big-application_1777489669889_51251_1` (~1.3 GB): stress-test the Web
  Worker streaming path.
- `lz4-application_1777393442674_464993` (~120 MB): decompressed from a real
  Spark History Server download. Use it to check the `LZ4Block` codec decoder
  by hand. The automated suite never touches it; `tests/lz4-block.test.js`
  uses a small hardcoded byte array instead.

Of the finding types moved onto the Gold Standard row/expand contract in the
widget-gold-standard plan, only `retryWaste` and `autoscalingChurn` fire on
any of the 15 real logs in `../spark-log-examples/`. `failures`,
`stageFailed`, and `jobFailureRate` fire on none of them; they were verified
with unit tests only (`tests/view/failures.test.tsx`,
`tests/view/job-failures.test.tsx`), not against a real log.

`dev/log-corpus/` is a git submodule pointing at the public
`spark-event-corpus-data` repo, pinned to a tag. It backs
`packages/server/test/shs-proxy-fixture.test.js`, which loads a real
`*-parquet-baseline.ndjson` fixture and asserts the `/shs-proxy` route
streams it back unmodified. Populate it locally with
`git submodule update --init dev/log-corpus`; without it, the test suite
skips (see [Development setup](./development-setup)).
