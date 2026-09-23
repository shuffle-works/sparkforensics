# Detector contract

`packages/core/src/detectors.ts` is the single source of Spark-optimization logic: one
declarative `DETECTORS` entry per pattern, each carrying `type`, `scope`
(`stage` / `app` / `config` / `sql`), `order`, `fixEffort`, a `thresholds`
object, impactBand/copy, a `docAnchor`, and a co-located `detect()` method.
Both consumers are thin loops over that array:

- `packages/core/src/analyzer.ts`: `analyze()` runs every entry regardless of scope, skipping
  only `inScorecard:false` ones; `auditConfig()` separately runs the
  `scope:'config'` entries. The four `configAudit` entries stay out of the
  bottleneck catalog because each sets `inScorecard:false`, not because of
  `scope:'config'`: a future config-scope detector without that flag would run
  through `analyze()` too. Each finding is stamped with its entry's `docAnchor`.
- `src/view/detector-registry.tsx`: a `REGISTRY: Record<findingType,
  {component, region}>` replaces `dashboard-renderer.js`'s `render:`
  bindings, one entry per emitted finding type. `orderedWidgets()` walks
  `DETECTORS` ascending by `order`, then sorts `action`-region components
  before `reference`-region ones. Every `finding.type` maps to its own
  component now (the 2026-09 widget/finding-type 1:1 mapping redesign split
  six components that used to multiplex several types each: `TaskSkew` into
  `Skew`/`StageShape`/`TinyTask`; `ShuffleIO` narrowed to `shuffle` only,
  plus a new `PartitionSizing`; `Failures` into `StageFailed`/
  `TaskFailures`/`RetryWaste`; `ExecutorTimeline` into `SlowHost`/
  `StageSlowness`/`Straggler`/`SpeculationWaste`/`ColdStart` (its
  non-finding-driven executor-count chart moved to `ExecutorCountChart`, a
  `ReferenceSection` tile, not a `REGISTRY` entry); `MemoryUtilization`
  narrowed to `memoryUtilization` only, plus a new `ExecutorUtilization` for
  `utilization`; `PlanFindings` into `DuplicatePlanSubtree`/`SmallFiles`/
  `UnderBroadcast`/`OverBroadcast`, dropping the dead `broadcastSizing` key
  entirely). No two `REGISTRY` entries share a `component` value any more.

  Each widget component receives the full catalog and self-gates when it has
  nothing to show, rendering `null` or a muted "no issue" card for the
  always-visible ones. `orderedWidgets()` itself has no empty/non-empty
  branching, since it iterates the static `DETECTORS` import, not the runtime
  `catalog`.

Thresholds live only in each entry's `thresholds`; see
[Bottleneck thresholds](#bottleneck-thresholds-spec-§4).

## Confidence disclosure

A `Detector` entry (or the `Finding` it returns) may carry `confidence: 'low' | 'medium' |
'high'` plus a `validationRequired` string. `RowStatusCluster` (`src/view/RowStatusCluster.tsx`)
is the one place that renders it, gated to Advanced density: a plain "&lt;confidence&gt;
confidence" badge whose tooltip carries the full `validationRequired` text. A finding with no
`confidence` field renders identically to a fully-validated one, so every detector whose
thresholds are our own unvalidated noise floor (marked `NOT SOURCED` in a code comment) should
set both fields, not just the ones that happen to already have `RowStatusCluster` wired into
their widget. `skew`, `straggler`, and `gc` set `confidence` for exactly this reason: their
runtime-floor thresholds carry the same kind of unvalidated-noise-floor caveat `coreLocality`,
`autoscalingChurn`, and `memoryUtilization`'s `wasteModel` variant already disclose. None of these
hardcode a single confidence value: each scales `'low' | 'medium' | 'high'` off how far the
finding sits past its own detector's threshold, via a small named helper placed just above the
`DETECTORS` array (e.g. `skewConfidence`, `coreLocalityConfidence`, `cachingReuseConfidence`)
rather than an inline literal.

## The `fixEffort` field

Each `Detector` entry also carries `fixEffort: 'config' | 'code' |
'rearchitect'`, alongside `order` and `thresholds`: a rough estimate of how
much work resolving the finding takes.

No view currently reads it. The quadrant impact/effort bucketing this field
was meant to feed (`bucketFinding`/`effortTier`/`computeImpactMagnitude` in a
since-deleted `src/quadrant-bucket.ts`, gated behind a
`FIX_EFFORT_MAPPING_REVIEWED` flag that never flipped to `true`) was removed
as dead code in the recommendations-consolidation redesign:
`FixTheseFirst` (`src/view/widgets/FixTheseFirst.tsx`) ranks purely by impact
magnitude. See
[Widget rendering order](./widget-rendering#widget-rendering-order-fixed-spec-§5)
for how it ranks findings today.

Two shared helpers back multiple detectors and reports. `packages/core/src/plan-tree-walk.ts`'s
`walkPlanTree(root, visit, {dedupe})` is the iterative pre-order plan-tree
traversal used by `detectors.ts` and every `plan-*.ts` module
(`plan-summary.ts`, `plan-duration-attribution.ts`, `plan-node-detail.ts`,
`plan-dot.ts`). `packages/core/src/core-count.ts`'s `computeTotalCores(app, executorsAdded)`
is the shared core-count logic used by `efficiency-model.ts`, `scaling-sim.ts`, and
`wasted-core-hours.ts`. `detectors.ts`'s own `utilization` and `memoryUtilization` entries use
the same file's `computePeakConcurrentCores`/`computePeakConcurrentExecutorCount` instead:
`computeTotalCores` sums every `ExecutorAdded` event with no regard for overlap, so under
executor churn (spot preemption, `dynamicAllocation` replacement) it double-counts a churned
executor's capacity against its replacement's; the peak-concurrent sweeps don't.

## Cross-detector suppression

An entry may declare an optional `suppressWhen(finding, out)` method.
`analyzer.ts`'s `push()`, the single choke point every finding passes through,
calls it per-finding, after the null guard and before the push, and drops the
finding silently when it returns `true`. `out` is the findings accumulated so
far. Since `analyze()`'s loop is detector-outer / stage-inner, every finding
from a detector declared earlier in `DETECTORS` is already in `out` by the time
a later detector runs, for every stage. That makes the pattern purely
declaration-order-driven: the suppressing detector must be declared earlier in
the `DETECTORS` array than the suppressed one.

`stageSlowness` uses this to defer to `slowHost`. It is spliced immediately
after the `slowHost` entry regardless of its `order` field (`order` only
controls render sequencing, not evaluation order), and
`tests/analyzer.test.js`'s "detector contract" suite asserts the array-index
ordering so a future reorder can't silently break the suppression. The
mechanism is deliberately minimal: a same-array, predicate-in-`push()` filter,
not a general dependency graph. `auditConfig()`'s own `push()` call is
unaffected, since `scope:'config'` entries declare no `suppressWhen`.

## Per-operator duration attribution

`packages/core/src/plan-duration-attribution.ts` (entry
`attributeStageDurationToPlan(planTree, stagesById, sqlExec)`) approximates how a SQL execution's
stage wall-time splits across plan operators, returning a
`Map<planNode, milliseconds>`. It cuts the plan tree at Exchange boundaries
into connected components: since the Exchange write/read split (`resolvePlanTree`
in `event-handlers.ts` always synthesizes a `read` node wrapping a `write` node
for every raw `Exchange`/`BroadcastExchange`), the cut is keyed off
`PlanNode.exchangeRole === 'read'` on the parent, not a name regex: the write
half starts the new component, the read half stays in its parent's. A node
with no `exchangeRole` at all (for example `ReusedExchange`, which is never
split) never starts a new component on its own, unlike the old name-based
regex, which matched any Exchange-family name regardless of split state. Each
component receives a stable pre-order identity
and separate parent/depth/traversal metadata; the identity itself does not
encode its count of Exchange ancestors. It zips components deepest-first by
that explicit depth against submission-ordered stage IDs, then apportions each
matched stage's wall-time across that component's nodes by timing-metric weight,
falling back to an even split when no node carries a timing metric.

This is best-effort inference, not measurement. Spark's event model exposes
no ground truth for per-operator time within a stage; the Exchange-boundary
segmentation and deepest-component-to-earliest-stage zip are heuristics. Treat the
per-operator numbers as directional hints, never as authoritative timings, and
do not build hard thresholds or findings on top of them.

## Stage-ID attribution for Plan Advisor findings

The Plan Advisor detectors (`duplicatePlanSubtree`, `smallFiles`, `broadcastSizing`
in `packages/core/src/detectors.ts`) each attribute their finding to a narrowed `stageIds` set
rather than the whole SQL execution: `PlanNode.stageIds` is resolved once per plan
tree at parse time by unioning, per node, every metric's accumulator ID against a
`taskAccumStages: Map<accumulatorId, Set<stageId>>` built while parsing `TaskEnd`
events, then clipping the result to the execution's own stage set. An accumulator
ID occasionally points to a *different* execution's stages, e.g. a `ReusedSubquery`
computed once and reused verbatim, and the clip prevents misattributing that other
execution's work. Each detector unions its implicated node(s)' `stageIds` and falls
back to the execution-wide set only when no implicated node has any coverage;
a finding never partially blends a narrowed set with the execution-wide one.
When an execution has no stage universe at all (no jobs ever recorded against it,
which is true for 42% of real-log SQL executions with a plan tree, typically
job-less/driver-only executions), the clip drops every candidate stage ID instead
of passing them through: every node in that execution's tree ends up with no
`stageIds` anywhere, same "coverage is partial" framing as below. (An
earlier version of this clip treated "no stage universe" as "no clip," which let a
foreign accumulator ID collision, e.g. the `ReusedSubquery` case above, leak
another execution's stages into a job-less execution's nodes; the clip is now
unconditional on `executionStageIds` being present.)

Coverage is partial by Spark's own design: whole-stage-codegen wrapper nodes (`InputAdapter`, and other purely
structural passthrough markers) carry no accumulators at all, and
`BroadcastExchangeExec`'s own metrics are computed entirely on the driver and
never appear on any `TaskEnd` (real Spark behavior). Since the Exchange
write/read split, those driver-computed metrics live specifically on the
synthesized *write* half (`exchangeRole: 'write'`); the *read* half always
carries `metrics: []`. The write half's immediate child, which does carry
executor-side metrics, is unioned in instead, see `overBroadcast`'s wiring. A
`TaskEnd` arriving after its stage has already been finalized is also
silently excluded from `taskAccumStages`, consistent with the parser's existing
out-of-order tolerance elsewhere.

`planTree` itself is kept current against Spark's adaptive query execution (AQE)
re-plans: `SparkListenerSQLAdaptiveExecutionUpdate` events overwrite the
execution's `sparkPlanInfo` last-write-wins, so
accumulator-ID evidence is matched against the plan that actually ran rather than
a stale pre-AQE snapshot. The raw `sparkPlanInfo` stays worker-side and is released
once `SQLExecutionEnd` resolves it into `planTree`; `physicalPlanDescription` (Spark's
text rendering of the plan, which nothing reads) is emptied before `JSON.parse` and
never retained (`stripPlanDescription`, `event-handlers.ts`).

No eviction/pruning is added to `taskAccumStages`, a deliberate choice, not an
oversight: measured on real logs, it holds roughly 1,050 keys per compressed MB
(9,850 keys on an 11.6 MB fixture, about 29,000 keys on a 28.1 MB fixture).
Extrapolated to a 240MB+ log, the scale this tool targets (see `CLAUDE.md`), that
is roughly 250,000 keys, around 45 MB of heap for an equivalent synthetic
`Map<number, Set<number>>`. This heap estimate is still small relative to this
tool's other in-memory state. It is higher, though, than the fixture-only
measurements taken when this mechanism was built suggested.

Per-execution pruning (e.g. dropping a `taskAccumStages` entry once its stage
finalizes or its owning SQL execution resolves, mirroring how `accumState` is
cleared in `endSqlExecution`) is deliberately not done either: unlike
`accumState`, `taskAccumStages` is one global, un-scoped map read by every
execution's `resolvePlanTree` call, and the `ReusedSubquery` case above depends
on a stage recorded under one execution still being visible when a later
execution resolves. Pruning on any single execution's lifecycle would break that
cross-execution lookup. What is bounded is the growth from a single pathological
event: `TaskEndEventSchema`'s `Accumulables` array is capped at
`MAX_ACCUMULABLES_PER_TASK` (10,000, `event-schemas.ts`), well above any real
plan's per-task metric count, so a single crafted `TaskEnd` can't grow the map
past that per-event bound; a `TaskEnd` exceeding it fails schema validation and
the line is skipped (counted in `skippedLines`) like any other malformed event.

## Bottleneck thresholds (spec §4)

Every change to `packages/core/src/detectors.ts` should reference this table.

Every finding's `impactBand` comes from one of two places. For any finding
whose `impactEstimate` carries a `wallClock` estimate (the common case for
most rules below), `analyzer.ts` calls `deriveImpactBand()`
(`packages/core/src/impact-band.ts`) immediately after `estimateImpact()`, which sets
`.impactBand` purely from `wallClock.high` as a fraction of the app's total
duration (`>= 2%` critical, `>= 0.5%` warning, else info: the same
`floorPctWarn`/`floorPctCrit` values `skew`/`straggler` use for their own
thresholds below). For those rules, the table below documents their firing
gate plus their fixed fallback constant, which surfaces only when this run's
finding of that type didn't get a wallClock estimate (a stage excluded from
the occupancy sweep). For rules whose finding type never gets
a wallClock estimate (`resourceOnly`/`informational` basis, e.g.
`configAudit`, or a rule that keeps its own ratio-tiered classification per
the design's Decision 2, e.g. `failures`), the full threshold table below is
the real, displayed classification: `detectors.ts` sets `impactBand`
directly and nothing overwrites it. `partitionSizing`'s `maxPartitionTooBig`
rule is a third case: it does carry a `wallClock` estimate but is explicitly
exempted in `deriveImpactBand()` because it's a hardcoded-critical OOM/crash-risk
safety signal, not a time-recovery one, so `detectors.ts`'s own classification
stands regardless of how small that estimate is relative to the run.

### Fixed fallback only (usually wallClock-derived instead)

These rules' *band* tiers were deleted from `packages/core/src/detectors.ts` (they were
always overwritten by `deriveImpactBand` whenever a wallClock estimate was
available); the constant in the last column is only a floor-case fallback.
Their *firing* gate is untouched and still lives in each entry's
`thresholds` object: it decides whether the rule reports anything, so it
stays documented here in full.

| Rule | Fires when | Fallback |
|---|---|---|
| Task skew | `taskDurationP95 / taskDurationP50 > 3×` (`taskDurationMax / P50` for stages under `minTasksForP95` = 20 tasks), **and** the occupancy-clipped P95−P50 (or max−P50) delta is ≥ `floorPctWarn` = 0.5% of app runtime. The clip floors the claim at the longest task the fix leaves, not the current one (see impact-estimation.md's occupancy section); `straggler`'s floors use the same clip | `warning` |
| Shuffle read | `shuffleReadBytes > minBytes` = 50 MiB | `info` |
| Partition sizing: skew | `shuffleReadMax > 5×` `shuffleReadP50` **and** `shuffleReadMax > 256 MiB` | `warning` |
| Partition sizing: low parallelism | `shuffleReadBytes ≥ 1 GiB` **and** `taskCount ≤ 7` | `warning` |
| Partition sizing: oversized partition | `shuffleReadMax ≥ 5 GiB` | `critical` |
| GC | `executorRunTime ≥ minRunTimeMs` = 10 s **and** `gcPct > 10%` | `warning` |
| GC (low / cost) | `executorRunTime ≥ 10 s` **and** `gcPct < lowInfoPct100` = 5% (checked only when the GC row above did not fire). Gets no wall-clock estimate (an over-provisioning signal), so this band always stands | `info` |
| Spill (magnitude v2) | any non-zero `memoryBytesSpilled`. The magnitude sub-table below classifies *how much*, but does not gate firing | `warning` |
| Cold start | `firstStageSubmittedAt − app.startTime > gapSeconds` = 30 s | `warning` |
| Slow host: mean-duration ratio | stage has ≥ `minHosts` = 3 hosts (or executors) and ≥ `minTasks` = 15 tasks; then per host: mean task duration / overall median ≥ `ratioWarn` = 2.0× **and** host task-share ≥ `minShare` = 20% **and** host mean ≥ `floorMs` = 1000 ms (absolute-magnitude floor, rules out sub-second noise) | `warning` |
| Slow host: duration-share | same stage gate as the row above; then per host: ≥ `shareWarn` = 75% of the stage's total task-duration **and** ≥ `taskShareWarn` = 50% of its task count | `warning` |
| Stage slowness: absolute fallback, suppressed when `slowHost` already fired | stage wall-clock duration ≥ `infoMin` = 15 min | `info` |
| Straggler / speculative-execution | `taskCount ≥ minTasks` = 10, **and** either any speculative task ran **or** straggler share > `shareWarn` = 5%. `warnPct`/`critPct` (10%/20% speculative share) and `floorPctWarn`/`floorPctCrit` (0.5%/2% of app runtime) no longer set the band; they rank the straggler-vs-speculative tiers that pick which *metric* the finding reports | `info` |
| Speculation waste (new) | `speculationWastedAttempts ≥ minWasted` = 5 **and** `speculationWasteMs ≥ minWasteMs` = 60 s | `warning` |
| Retry waste | `wastedAttempts ≥ minWasted` = 3 **and** `retryWasteMs ≥ minWasteMs` = 30 s, on a stage that still completed | `warning` |
| Tiny tasks | `taskCount ≥ minTasks` = 100 **and** `taskDurationP50 ≤ maxP50` = 500 ms **and** `taskDurationP95 ≤ maxP95` = 1000 ms | `info` |
| Duplicate plan subtree | a subtree of ≥ `minSubtreeSize` = 3 nodes whose shape fingerprint repeats ≥ `minOccurrences` = 2× in the plan | `warning` |
| Small files read/write | per read/write side: file count > `minFiles` = 100 **and** average file size < `maxAvgFileSizeMB` = 3 MiB | `warning` |
| Broadcast sizing: missed | a 2-child `SortMergeJoin` whose smaller side is < 10 MiB (unconditional), or < 100 MiB with the larger side > 10 GiB, or < 1 GiB with larger > 300 GiB, or < 5 GiB with larger > 1 TiB (`broadcastTiers` × `comparisonTiers`) | `info` |
| Broadcast sizing: oversized | a `BroadcastExchange` node whose `data size` metric > `overBroadcastBytes` = 1 GiB | `warning` |

#### Spill magnitude tiers

The spill row's band is a fixed `warning` fallback, but `computeSpillMagnitude`
(`packages/core/src/detectors.ts`) still runs on every spill finding and sets its
`spillMagnitude` field, which the Spill widget displays. Its tiers, in
evaluation order (first match wins, `null` when nothing matches):

| Condition | Magnitude |
|---|---|
| Single-task stage: `spillDiskMax ≥ singleTaskDiskGiB` = 1 GiB **or** `spillMemMax ≥ singleTaskMemGiB` = 4 GiB | `severe` |
| Multi-task stage: `spillDiskMax ≥ highDiskGiB` = 1 GiB, **or** `spillDiskMax / taskCount ≥ highTaskDiskMB` = 512 MiB (per-task proxy), **or** `spillMemMax ≥ highMemGiB` = 4 GiB | `high` |
| Multi-task stage: `spillDiskMax ≥ medDiskMB` = 256 MiB **or** `spillMemMax ≥ medMemGiB` = 1 GiB | `medium` |
| Skew (`taskCount ≥ skewMinTasks` = 10): `spillDiskMax / spillDiskP50 > skewRatio` = 5× **and** `spillDiskMax ≥ skewDiskFloorMB` = 128 MiB | `high` |
| Skew (`taskCount ≥ 10`): `spillMemMax / spillMemP50 > 5×` **and** `spillMemMax ≥ skewMemFloorMB` = 256 MiB | `medium` |

Disk spill is weighted worse than memory spill by design: the memory
thresholds sit well above their disk counterparts at every tier.

### Full threshold table (never wallClock-derived)

| Rule | Warning | Critical |
|---|---|---|
| Stage shape: PRatio | `taskCount / totalCores < 0.5` (info, under-parallelized) | none |
| Stage shape: OIRatio | `outputBytes / inputBytes > 10×` (info, data explosion) | none |
| Stage shape: TaskStageSkew | `taskDurationMax / stageDuration > 3×` (info) | none |
| Failed tasks | failure rate > 5% (min 10 tasks) | > 20% |
| Stage failed outright | none | any `stageFailureReason` present |
| Slow host: multi-dimensional | max/median ratio across taskTime/inputBytes/shuffleBytes/storageMemory ≥ 1.33× (info); each dimension's sample must also clear an absolute floor (1000 ms for taskTime, 64 MiB for the byte dimensions) | ≥ 3.16× warning, ≥ 10× critical |
| Utilization | avg active executors / peak < 60% (info) | none |
| Autoscaling churn: short-lived executors (design spike, unvalidated thresholds) | > 30% of executors alive under 2 min (min 5 executors) | > 60% |
| Job failure rate | ≥ 30% (≥ 10% info) | ≥ 50% |
| Idle cores | busy-core-time / (peak cores × wall-clock) idle > 50% (warning) | none |
| Memory band | peak heap / allocated > 95% too-small (warning); < 70% over-provisioned (info) | none |
| Caching opportunity | RDD read across ≥3 stages without `.persist()` | none (single tier, info) |
| Cache utilization: partial caching (this repo) | `numCachedPartitions / numPartitions < 0.90` (info) | `< 0.50` (warning) |
| Cache utilization: disk spillover (this repo) | `diskSize / (memorySize + diskSize) > 0.15` (info), `MEMORY_AND_DISK*` only | `> 0.40` (warning) |

Spill classification: ≥80% tasks with zero spill → `skew`; <20% zero →
`volume`; else `unclassified`. The classification badge is always shown in
both compact and expanded spill widget states. This is independent of the
magnitude tiers above: classification says *what kind* of spill, magnitude
says *how much*.

#### Evidence fields (`stageFailed` / `retryWaste`)

Neither entry's `detect()` used to put anything beyond a scalar `metric`/
`value` on its finding. Both now also attach:

- `numTasks`: `stage.taskCount` at detection time.
- `memoryBytesSpilled`: `stage.memoryBytesSpilled` at detection time.
- `stageFailed` only: `failedTaskDetails`: up to 20 `FailedTaskSample`
  records (`taskId`, `attemptNumber`, `host`, `executorId`, `reason`,
  `peakExecMem`, `memSpilled`, `shuffleWrite`) for tasks still marked
  failed when the stage was finalized (`finalizeStage`, `stage-quantiles.ts`).
- `retryWaste` only: `retriedTaskDetails`: up to 20 `FailedTaskSample`
  records for attempts discarded by the retry-dedup logic in
  `accumulateTask` (`event-handlers.ts`): captured at the moment they'd
  otherwise be thrown away, since by finalize time only the winning attempt
  survives.

Both sample arrays are capped at 20 entries, filled in first-encountered
order (finalize order for `failedTaskDetails`, discard order for
`retriedTaskDetails`), not spread across distinct hosts/executors: a stage
with failures clustered on one bad host could fill the cap before a more
informative failure elsewhere in the stage is ever sampled. This is the
first evidence-shape documentation in this file; no other finding type has
one yet.
