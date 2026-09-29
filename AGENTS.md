# CLAUDE.md

Spark event-log analyzer: a static, zero-backend browser dashboard (React +
TypeScript in `src/`, optional local-server mode in `packages/server/`) that
parses Spark History NDJSON logs in a Web Worker. Shared analysis lives in
`packages/core/` (`@sparkforensics/core/*`), which the CLI and MCP packages
vendor. Contributor docs: `docs-site/contributor-guide/` (start at
`architecture/index.md`, `development-setup.md`, `testing.md`).

## Interaction rules

When the user asks a question or requests advice, DO NOT edit or delete any
files until you have answered and received explicit confirmation to make
changes. Never touch tracked files while only answering a question.

Subagents must pin their cwd to their isolated worktree, never the main repo.
Before asserting a root cause, verify it with concrete evidence and state what
was checked; if uncertain, say so.

## Commands

- Tests: `npm test` (root: site app and dev tooling), `npm run test:core`,
  `npm run test:cli`, `npm run test:mcp`, `npm run test:server`. Each package
  suite is separate; none is part of `npm test`. Single file:
  `npm test -- tests/finding-filter.test.js`.
- Typecheck `npx tsc --noEmit`; lint `npm run lint`; dev server `npm run dev`;
  build `npm run build` (docs site, app, export template).
- Corpus gate: `node dev/bench-analyze.mjs --check dev/corpus-snapshot.json`.
  After an intended finding change, `--update` it and commit the snapshot
  (`testing.md#corpus-regression-snapshot`). Other detector, estimate and
  fzstd tools: `testing.md#detector-and-estimate-tools`.
- CLI: `node packages/cli/bin/sparkforensics-analyze.mjs <file|dir>`; `--help`
  lists budgets, baseline gating, `--thresholds`, `--redact` and
  `--export-html`.

Before a PR or commit, run the full suite for every package you touched,
verify UI changes in a real browser (`development-setup.md#driving-the-app-in-a-browser`),
and report the passing test count. A PR touching `packages/*`, `src/` or root
build config needs a `.changeset/*.md` (`scripts/check-changeset.sh`,
`contributing.md#changesets-and-releases`).

## Rules that prevent real breakage

- Private logs: real logs in `../spark-log-examples/` and `examples/` are
  private and this repo is public. Never put their file names, app IDs, app
  names, tables or paths in tracked files, commits or PR text; use the
  `private-log-NN` labels (`testing.md#test-fixtures`) and synthetic IDs such
  as `application_0000000000000_0001`.
- Never commit spec or plan files (`docs/plans/`, `docs/specs/`,
  `docs/superpowers/specs/` are gitignored). New docs go in exactly one tree:
  `docs-site/` for readers, `docs/` for internal records.
- Treat `src/` and `tests/` as the source of truth, not old doc references.
  Detector ideas often come from other Spark log tools: check whether the
  category already exists before proposing one.
- Detectors: thresholds live in each `packages/core/src/detectors.ts` entry
  and are frozen; the dashboard always runs them, and only the CLI/MCP
  `--thresholds` overrides them, through `analyze()`'s `thresholds` option.
  Read `architecture/detector-contract.md` and `architecture/widget-rendering.md`
  before adding a detector, changing a threshold or changing render order.
  Each finding type's name, tag and summary is one row in
  `packages/core/src/finding-presentation.ts`; its widget is in
  `src/view/detector-registry.tsx`'s `REGISTRY`.
- Problem flagging: colored impact dot + ALL-CAPS tag, no emoji, flag every
  affected stage, never just the worst. Tags: `SKEW`, `SHFL`, `SPILL`, `GC`,
  `COLD`, `UTIL`, `MEM`, `FAIL`, `JOBS`, `CFG`, `PLAN`, `SFAIL`, `PART`,
  `SLOW`, `SHAPE`, `CACHE`, `CSTOR`, `STRAG`, `RETRY`, `SPEC`, `TINY`,
  `LOCAL`, `CHRN`, `HOST`, `INCMP` (`packages/core/test/tag-vocabulary.test.js`
  checks this list). Every widget self-wraps in `WidgetCard`, which owns the
  `<h3>` title.
- UI copy stays domain-agnostic: no company, industry or dataset references in
  rendered output.
- Analysis both the dashboard and the CLI/MCP show belongs in
  `packages/core/src/`; `src/view/` only renders it. Conclusions about a run
  are computed once by `interpretRun` and shipped in the HTML export. The
  export build fails when its graph reaches a core module off
  `ALLOWED_EXPORT_CORE_MODULES` (`scripts/export-analysis-guard.mjs`): never
  widen it to get past the guard, and keep `detectors.ts` imports type-only
  there (`architecture/state-and-history.md#run-interpretation`).
- Generated content, never hand-edited:
  `packages/core/src/docs-content/{chapters,tuning,diagrams}` comes from the
  pinned tuning reference (fix upstream, then `npm run docs:bump`), and
  `docs-content/detection/*.md` from `npm run split-detection-docs`.
  `vendor-core/` and the CLI's `export-template/` go stale locally
  (`development-setup.md#generated-and-vendored-files`).
- zstd decodes differently in the browser (fzstd) and in Node (native, frame
  by frame): a parser change that depends on chunk shape must hold for both
  (`architecture/worker-protocol.md#zstd-in-the-browser-and-in-node`).
- Test-suite growth: reuse `tests/view/_shared/` and
  `packages/core/test/fixtures/` before pasting boilerplate
  (`testing.md#test-suite-growth-discipline`).
- Redesigning a `src/view/` component: use the `capturing-real-component-html`
  skill to capture the real markup and CSS instead of guessing.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
