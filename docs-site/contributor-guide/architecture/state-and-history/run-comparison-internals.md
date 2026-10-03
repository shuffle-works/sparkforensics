# Run comparison internals

How the A/B comparison engine matches stages and builds a comparison.

## Run comparison

`packages/core/src/run-comparison.ts` is the whole A/B engine. The entry point
`compareRuns(baseline, candidate)` takes two `{ label, snapshot }` run records
(each `snapshot` a `SessionSnapshot`: `app`, `stages`, `executors`, `sql`,
`jobs`, `runAggregates`, `evidenceAvailability`, `catalog`, `taskData`) and returns one plain object the view renders. It runs on
already-parsed snapshots, with no worker involved.

- `stageIdentity(stage, snapshot)` is a run-independent key: `normalizeStageName`
  (lowercased, digit-runs and long hex ids collapsed to `#`) joined with the
  stage's SQL-execution plan identity. That identity is scoped to only the plan
  nodes this stage's tasks were attributed to (`node.stageIds`), not the whole
  tree, so two stages sharing one SQL execution (e.g. a self-join's two
  Exchange stages) don't collapse onto one identity; it falls back to a
  bottom-up structural fingerprint of the whole resolved `planTree`
  (`planTreeIdentity`, `normalizeDetail`-normalized: the same normalizer
  `cachingOpportunity` uses in `packages/core/src/detectors.ts`) when a stage has no such
  attribution.
  The stage-to-plan mapping itself is `planNodesOfStage` in
  `packages/core/src/stage-plan-nodes.ts`, shared with `isPythonStage`
  (`python-stage.ts`), which the CLI's `metrics` block (`run-metrics.ts`) and
  the `tasksMostlyIdle` check both read. The CLI keys its per-stage metrics rows
  by this identity.
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
(the comparison page), `CompareLanding.tsx` (the two-slot baseline / candidate intake
off the landing), and `PinnedStageDeltas.tsx` (the manual per-stage pinning
panel fed by `baseStages`/`candStages`).
