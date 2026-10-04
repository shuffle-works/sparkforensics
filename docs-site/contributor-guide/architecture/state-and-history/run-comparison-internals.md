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
- `alignStages(baseSnap, candSnap, { normalizePath })` in
  `packages/core/src/stage-alignment.ts` is the aligner: a pure function from two
  snapshots to the stage pairs, the unmatched stages, the replanned groups, the
  Delta bookkeeping stages, the runtime coverage and the execution alignment.
  `compareRuns` calls it and does not contain it, and every consumer of a
  comparison reads its `stagePairs` instead of comparing stage keys. It pairs in
  two levels.
  - Keys. The exact key is `comparisonIdentity`, the `stageIdentity` recipe
    (shared in `packages/core/src/stage-identity.ts`) run with the comparison
    normalizer: `normalizeDetail`, then the targeted patches in
    `COMPARISON_PATCHES` (staging directories, dates, `IN` lists, file-index
    counts), with any caller-supplied patterns (`compileNormalizePatterns`)
    applied first to the text as Spark printed it. The structural key
    (`structuralKey` in `packages/core/src/stage-structure.ts`) folds the
    attributed nodes into a forest, each node as its normalized name, its sorted
    attribute names (`name#id` references without the id, so a literal never
    enters it) and its children's digests; codegen and input-adapter nodes are
    skipped. `stageIdentity` stays the exact key the CLI's per-stage metrics rows
    use, and `normalizeDetail` stays untouched, so findings do not move. Blanket
    numeric or path stripping is not part of the normalizer: it fused distinct
    stages of one run.
  - Executions first. `indexRun` groups each run's non-bookkeeping stages by SQL
    execution (stages with no execution form one pseudo-execution) and gives
    each execution its plan structure, call-site frames and description tokens.
    `alignSequences` (`packages/core/src/sequence-alignment.ts`) runs the
    order-preserving weighted LCS over the executions in id order, scored by
    `executionSimilarity` (weights 4, 2 and 1 for structure, frames and
    description; a part one side lacks drops out) with `EXECUTION_MATCH_MIN`
    0.55. It prefers matching where matching is optimal and otherwise skips the
    execution with the higher id, which makes the result deterministic and
    mirror-symmetric. Up to `FULL_ALIGNMENT_MAX_CELLS` (1,000,000) the table is
    full; above it the table is a band of half-width `BAND_BASE_HALF_WIDTH` (100)
    plus half of the length difference, and `executionAlignment.bounded` says so.
    If fewer than `MIN_EXECUTION_AGREEMENT` (0.5) of both runs' executions pair,
    no stage pairs (`executionAlignment.accepted` is false).
  - Stages second (`alignWithin`). In each aligned execution pair: equal exact
    key (`exact`, pairing off in stage-id order as many as both sides have), equal
    structural key (`structural`), detail-token Jaccard of at least
    `ALIGNED_MIN_SIMILARITY` (0.6, best pair first; `aligned`), and plan-less
    stages by position among those of one name (`aligned`, `POSITIONAL_SCORE`).
    Stages outside any execution key on their call-site text too.
  - Re-plan fallback. When an aligned SQL execution pair holds different numbers
    of non-bookkeeping stages and stages are left over, they form one
    `ReplannedGroup` (both execution ids, the leftover ids per side, `deltas`
    totalled per side). Equal counts leave them unmatched. With
    `REPLANNED_COUNTS_TOWARD_COVERAGE` the replanned run time counts in the
    numerator of `runtimeCoverage`; set it to false and it counts in the
    denominator only.

  Stages whose scans only read the Delta log (`isDeltaBookkeepingStage`, built on
  `isDeltaLogRead` in `plan-summary.ts`) are set aside before pairing. A pair's
  `deltas` sum every attempt of the stage, the sums `withEarlierAttempts` gives the
  run totals. The result is `comparisonSchemaVersion` 1.
- The per-stage skew deltas (`stageSkewDeltas`) read the aligner's pairs, the
  same ones the banner's coverage figure counts, and the pinned-stage panel
  reads `baseStages`/`candStages`. The old `matchStages` pairs still feed
  `matchedCoverage`, which keeps its count-based meaning and decides nothing.

`compareRuns` sets `confidence` from `runtimeCoverage`: `insufficient` when it is
null (neither run recorded executor run time), `low` when it is under 0.9
(`RUNTIME_COVERAGE_THRESHOLD`) or the two app names differ (either condition
alone is enough; both are weak signals, not a hard gate), `ok` otherwise. It is
computed in `compareRuns`, not in `buildComparison`, so the dashboard, which calls
`compareRuns` directly, gets the same result as the CLI and MCP. The view
lives in `src/view/RunComparison.tsx`
(the comparison page), `CompareLanding.tsx` (the two-slot baseline / candidate intake
off the landing), and `PinnedStageDeltas.tsx` (the manual per-stage pinning
panel fed by `baseStages`/`candStages`).
