# TypeScript core and runtime event validation

How the shared TypeScript core types and validates the events it reads.

All of `src/` (browser SPA) and `packages/core/src/` (shared analysis logic)
is strict TypeScript, except for a few plain-`.js` files: the two vendored
third-party decompressors, `packages/core/src/vendor/fflate.js`
and `packages/core/src/vendor/fzstd.js` (left untouched deliberately: vendored code, not
project code), `load-vendored.js` (copied byte-for-byte into `vendor-core/`, so it must
run without TS stripping), and the SHS helpers `shs-request.js` and `proxy.js`, which the
local server imports as plain JS. Every remaining import of a same-repo `.ts` module uses a `.ts`
specifier (e.g. `import { dispatchLine } from './event-handlers.ts'`), not
`.js`: the CLI and MCP entrypoints (`packages/cli/bin/sparkforensics-analyze.mjs`,
`packages/mcp/bin/sparkforensics-mcp.mjs`) run under plain Node's ESM resolver, which
cannot remap a `.js` specifier to a same-named `.ts` file the way Vite/Vitest's
bundler-style resolver can. `tsconfig.json` sets
`"allowImportingTsExtensions": true` to make this legal.

Event schema validation lives in `packages/core/src/event-schemas.ts`: one zod schema per
`SparkListener*` event variant the parser understands (17 total: `LogStart`,
`ApplicationStart`, `EnvironmentUpdate`, `ApplicationEnd`, `JobStart`,
`JobEnd`, `StageSubmitted`, `StageCompleted`, `StageExecutorMetrics`,
`TaskEnd`, the four SQL-execution-UI listener events, `ExecutorAdded`,
`ExecutorRemoved`, `BlockUpdated`), combined into `SparkEventSchema =
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
data it does not control. Both run that data through a schema, and both
treat a validation failure the same way: a silent skip, not a distinct error.

- `dispatchLine` (`event-handlers.ts`): after `JSON.parse` succeeds, a line
  whose `Event` value is one of the 17 modeled types but fails that type's own
  schema increments `skippedLines`. An `Event` value outside the 17 modeled
  types is silently ignored without incrementing `skippedLines`: real Spark
  logs always carry plenty of ordinary event types this tool does not model
  (`TaskStart`, `BlockManagerAdded`, `ExecutorMetricsUpdate`, and others), and
  counting them would trip `evidence-availability.ts`'s fail-closed
  `trustworthy` gate on healthy logs. One exception: an AQE update that a later update for the same
  open execution supersedes is never parsed (`deferAdaptiveUpdate`, see
  [the detector contract](../detector-contract.md)), so a malformed
  superseded update is not counted.
- `shs-fetch.ts`: on a non-OK response from the local SHS proxy, the JSON
  error envelope is validated against `ShsProxyErrorBodySchema`
  (`packages/core/src/shs-schemas.ts`, `{ code: string }`, `.passthrough()`). A body that
  isn't valid JSON, or is JSON but fails that schema, falls back to the
  generic `access-or-upstream-failure` code: the same silent-skip treatment
  as a malformed log line. There is no separate "malformed SHS response"
  error code.

Neither boundary distinguishes "malformed JSON" from "wrong shape" from
"unrecognized variant" in what it reports outward: all three collapse into
the same skip/fallback path. That is a deliberate scope decision.

The exhaustiveness convention is `packages/core/src/assert-never.ts`. `assertNever(x: never):
never` throws at runtime and, more importantly, fails `tsc` at compile time if
`x` is not actually `never`, i.e. if some case of a union type isn't handled.
Used at the `default` arm of `event-handlers.ts`'s `processEvent` switch
(over `SparkEvent`) and `analyzer.ts`'s scope-dispatch switch (over a
detector's `scope: 'stage' | 'sql' | 'app' | 'config'`). It is the project's
standard pattern for any future exhaustive switch or dispatch over a closed
union: add `default: return assertNever(x);` (or the closest
non-returning equivalent) so that adding a new union member without updating
every consumer becomes a compile error instead of a silent runtime gap.
