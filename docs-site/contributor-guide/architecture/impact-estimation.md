# Impact estimation

Every finding covered by this section carries an optional `impactEstimate: {basis,
wallClock, estimateMethod, rawWaste?}` (`src/types.ts`), attached by
`src/impact-estimator.ts` as a post-pass after `DETECTORS` finishes (`src/analyzer.ts`).
`estimateMethod` ('measured' | 'modeled' | 'none') is a distinct axis from the per-finding
`confidence` field ([Confidence metadata](./board-widgets#confidence-metadata)):
`confidence` says how much to trust the finding itself,
`estimateMethod` says how its impact number was derived. `'none'` marks a purely
informational finding with no waste model at all (`configAudit`, `stageFailed`,
`failures`, `incompleteRun`, `slowHost`'s byte-dimension multiDim shapes): it's distinct
from `'measured'`/`'modeled'`, which both attach a real (if approximate) formula. `basis`
is one of:

- `'serial'`: the tied stage ran (effectively) alone; `wallClock` is a near-point
  estimate, `low === high`.
- `'contended'`: the tied stage shared wall-clock time with others; `wallClock` is an
  honest range, `high` optimistic (assumes the fix could still fully land), `low` the
  guaranteed floor.
- `'resourceOnly'`: no wall-clock claim is defensible (not stage-tied by nature, or the
  stage was excluded from the occupancy sweep), `wallClock: null`, but the formula's
  real signal survives in `rawWaste`.
- `'informational'`: no quantifiable magnitude at all, `wallClock: null`, no `rawWaste`.

`{basis: 'resourceOnly'|'informational', wallClock: null}` replaced the earlier design's
`{low: 0, high: 0}`: that single value used to mean two incompatible things ("provably no
wall-clock cost" and "the model gave up"), and 76-97% of stage-tied findings on real logs
were the second case wearing the first case's clothing (2026-08-30 N1 redesign; see
`docs/superpowers/specs/2026-08-30-critical-path-occupancy-redesign.md`).

`rawWaste` is not exclusive to `resourceOnly`/`informational` findings: every `serial`/
`contended` finding carries it too (the only exceptions are `coldStart`, whose `wallClock`
figure is already unclipped, and `estimateMethod: 'none'` findings, which have no formula at
all), holding the formula's pre-clip magnitude in the formula's own natural unit (ms,
bytes or core-ms). `wallClock` is what the occupancy model says is recoverable, which clips
against the stage's own physical floor; `rawWaste` is what the stage really wasted either
way. The two answer different questions.

## Occupancy-weighted attribution

`src/occupancy.ts` sweeps every stage's observed `[submittedAt, completedAt)` window and
splits each instant's wall-clock among concurrently-active stages proportional to
`coreWeight(S) = stage.executorRunTime / stageDurationMs` (an average-concurrency proxy,
held constant across the stage's whole window: this codebase has no per-task timestamps
outside the parser worker to do better). Summing a stage's share across its own window
gives its `occupancy(S)`; `gate(S) = occupancy(S) / duration(S) ∈ [0, 1]` is the single
number that replaces the old CPM model's `onCriticalPath`/`slackMs`/`isUniquelyCritical`.
1.0 means the stage ran completely alone; 0 means the stage had zero `executorRunTime`
while overlapping other, positive-weight stages, so it got no share of the shared window.
Stages with `duration(S) <= 0` (Spark-skipped stages, or a malformed
`submittedAt === completedAt`) are excluded from the sweep entirely.

This mechanism replaced a CPM (critical-path-method) graph over `parentIds` that produced
near-zero on-critical-path membership on real logs (0.1-10.6% of stages, max graph depth 2
on 5 of 6 real logs measured): `parentIds` alone is too sparse a precedence signal for a
meaningful longest-path computation. The same degeneracy fed `efficiency-model.ts`'s
`floorInfiniteMs` ("floor with infinite executors"); rather than leave a second,
unreconciled critical-path number in the codebase for a future UI to display next to
the occupancy-based figures above, `criticalPathMs()`/`CriticalPathStage` (embedded in
`efficiency-model.ts`, never a standalone module) were removed outright (no
occupancy-based replacement: occupancy apportions observed concurrent time, it doesn't compute
a dependency-graph longest path, so there's no drop-in equivalent). `efficiency-model.ts` now
reports only `floorZeroSkewMs` (total task time / total cores) as its theoretical floor.

`ceiling(S) = max(stage.taskDurationMax, stage.executorRunTime / totalCores)` is a physical
floor on a stage's own duration: bounded below by its single longest task (unsplittable no
matter how much parallelism exists) or by its core-work spread across every core in the
cluster, whichever is larger. Every waste formula's raw claim is clipped against it before
gate-weighting: `wasteMs_clipped(S) = min(wasteMs_claimed, max(0, duration(S) - ceiling(S)))`,
so a finding can never claim to save more than the portion of the stage's observed duration
that sits above its own unbeatable floor. This is what fixes historical overclaim bugs (a
`tinyTask` finding claiming 407.5s on a 13.1s stage capped to 8.9s; a `shuffle` finding
claiming 1939.9s on a 991.3s/1688.3s stage capped to 610.3s/250.1s).

`analyzer.ts` feeds this `totalCores` from `src/core-count.ts`'s
`computePeakConcurrentCores(app, executorsAdded, executorsRemoved)`, not the shared
`computeTotalCores` helper. `computeTotalCores` sums every `ExecutorAdded` event's cores
regardless of overlap, so under dynamic allocation or executor replacement it can far exceed
the cores ever actually concurrent, which understates `ceiling(S)` and lets churn inflate a
finding's claimed wall-clock. `computePeakConcurrentCores` instead sweeps add/remove events by
timestamp and tracks the running total's peak, so a churned-through executor's cores are never
double-counted against its replacement's. Same-timestamp events tie-break by delta ascending, so
a removal applies before a same-instant replacement's addition (otherwise a same-instant swap
would momentarily double-count both as concurrent). If every `executorsAdded` entry lacks
`totalCores` the cores sweep peaks at zero and tells us nothing; the function then falls back to
sweeping peak *executor count* instead (still concurrency-aware, just cores-blind) and multiplies
by the configured per-executor core count, rather than falling back to
`executorsAdded.length × cores`, which would reintroduce the exact cumulative-overcount-under-churn
bug this function exists to avoid.

Per-finding estimate, using `wasteMs_clipped(S)`:

- `gate(S) >= 0.999`: `basis: 'serial'`, `low = high = wasteMs_clipped(S)`.
- `gate(S) < 0.999`: `basis: 'contended'`, `high = wasteMs_clipped(S)`,
  `low = wasteMs_clipped(S) * gate(S)`.

A finding spanning multiple stages (`stageIds`, plural) sums each stage's own estimate and
caps the joint total at the union of just that finding's own stage windows (via
`mergeIntervals`, `src/wall-clock.ts`): `high = min(Σ high_i, unionMs(stageIds))`,
`low = min(Σ low_i, unionMs(stageIds))`. This is what prevents overclaiming when two or more
of a finding's stages overlap in wall-clock time: a plain sum-and-cap, no CPM re-simulation.
The union cap can force `low === high` numerically even when the constituent stages were
individually contended (e.g. two fully-overlapping stages each at `gate` 0.5), so `basis`
isn't derived from that numeric equality: a multi-stage finding gets `basis: 'serial'` only
when every one of its per-stage estimates was itself `'serial'`; otherwise `'contended'`.

Regression guard: a finding whose stage (or, for a multi-stage finding, every one of its
stages) ran alone (`gate >= 0.95`, deliberately looser than the `0.999` "serial" cutoff
above: this guard exists to catch egregious false zeros, not to gate which `basis` a finding
gets) with a real underlying magnitude (`rawWaste.value > 0`) must never report
`wallClock.high === 0` or `basis: 'informational'/'resourceOnly'`. Covered by
`tests/impact-estimator-real-log.test.js` against a real fixture; relies on `rawWaste` being
attached to every serial/contended-capable formula (see above), so it's blind only to
`coldStart` and the purely informational (`estimateMethod: 'none'`) finding types.

Real-log spot-check (2026-08-30, `grupo-semanal-beauty-application_1785266278671_91660.zstd`): median `gate` across stages was
`≈0.34` (0.3428060791718594 exactly); `collectRun` plus the occupancy sweep together took
`≈6,589`ms on the largest fixture measured
(`run-compare-calimax-candidate-application_1784568768686_119096.zstd`, `1169` stages):
parse-dominated, the sweep alone was not isolated by this measurement, but not a magnitude
that suggests a regression either. `54` previously-`{0,0}`
stage-tied findings on stages that ran effectively alone now report a real `wallClock` range
instead.

## Cross-finding rollup: `computeStageUnionMs`

The Findings tab's recommendation rollup (`FixTheseFirst.tsx`, built from
`buildRecommendationRollup`, `src/recommendation-rollup.ts`) groups the
filtered catalog by detector `type`, then needs its own cap for a group of
several findings of that type, not just one finding's own `stageIds`. Summing
each finding's already-clipped `wallClock.high` naively double-counts any
stage two of those findings both touch. `computeStageUnionMs(stageIds,
stages)` covers this: collect every stage touched by any finding in the
group, merge their `[submittedAt, completedAt)` intervals, and sum the
merged intervals' durations, so the group's wall-clock union holds
regardless of how many findings' `stageIds` overlap. Stages missing either
bound are skipped rather than defaulted to `0` (the same filter
`computeWallClock` applies), so a truncated log (the case `incompleteRun`
flags) can't contribute a negative interval and a negative recoverable-time
figure.

It reuses the same `mergeIntervals` primitive (`src/wall-clock.ts`) that
backs `src/occupancy.ts`'s per-finding `estimateMultiStage`/its internal
`unionMs` sum, but is not an extension of that function: `estimateMultiStage`
caps one finding's own multi-stage claim during the impact-estimation pass,
before a `Finding` object even exists; `computeStageUnionMs` runs later,
in the view layer, capping a naive sum *across* several already-estimated
findings that happen to share a detector `type`. `buildTimeGroup` (same
module) takes the smaller of the naive per-finding sum and this union figure
as the group's `recoverableMsHigh`, falling back to the naive sum untouched
when the group's findings carry no stage IDs at all (nothing to union
against).

Within one `type` group, `buildRecommendationRollup` splits findings into up
to three tiers, always rendered in this fixed order. `time` covers findings
with a real `impactEstimate.wallClock` (`buildTimeGroup`, the union-capped
figure above). `resource` covers findings with no `wallClock` but a
`rawWaste` figure (`buildResourceGroup`), grouped again by `rawWaste.unit` so
a `bytes` total never gets summed against a `coreHours` total under one
type. `count` covers findings with neither (`buildCountGroup`), a plain
per-impact-band tally with no magnitude claim at all. Each `RollupGroup` also
carries its own `findings: Finding[]` (the exact members that fed the
aggregate), which `FixTheseFirst.tsx` reads directly to pick a group's
highest-impact member and to render its expanded, paginated list.

A type only contributes a tier when it has at least one finding of that
kind; most types produce exactly one tier, but a type whose formula varies
by `variant`/`rule` (e.g. `memoryUtilization`, see the coverage table below)
can produce more than one.

`cachingOpportunity` and `cacheUtilization` are both `cost-only`: `basis:
'resourceOnly'`, `wallClock: null`, but `rawWaste.unit` is `'ms'`, the same
unit a real `wallClock` figure would use, because their formula's natural
output happens to be time (a re-read cost), not because either finding
makes a wall-clock claim. Left unlabeled, a `resource`-tier "ms" total sitting
next to a `time`-tier "recoverable time" total would read as directly
comparable when it isn't: the resource figure was never gate-clipped against
any stage's occupancy, so it can exceed what the stage actually spent.
`FixTheseFirst.tsx` calls this out via its trailing-stat copy: a `resource`-
kind group (any unit, including `ms`) always reads "resource-cost
projection", never "recoverable", so the two ms-shaped numbers are never
mistaken for the same kind of claim.

## Per-formula spot-checks

| Detector | Formula basis | Spot-check |
|---|---|---|
| gc | `jvmGCTime / (executorRunTime / stageDurationMs)` | `grupo-semanal-beauty-application_1785266278671_91660.zstd`, stage 507: `jvmGCTime`=1080ms, `executorRunTime`=27509ms, `stageDurationMs`=56279ms → `wasteMs` = 1080 / (27509/56279) ≈ 2209.5ms. That's ≈3.9% of the stage's 56.3s wall-clock duration, matching the finding's own reported `gcPct` (3.9%) exactly, as the formula guarantees by construction. Under the occupancy model this stage's `gate` is `0.041` (0.04145044590332269 exactly): `basis: 'contended'`, `wallClock: {low: 91.6, high: 2209.5}` (91.5850382272182 / 2209.506706895925 exactly, per the Step 1 script's per-stage output). |
| shuffle | `shuffleReadBytes / SHUFFLE_THROUGHPUT_BPS` (fallback tier; real-metrics parser not yet built) | `ventas-mensual-multi-big-application_1785266278671_91510.zstd`, stage 99 (`SHFL` finding): `shuffleReadBytes`=204,172,518,504 → `wasteMs` = 204172518504 / 125,000,000 × 1000 ≈ 1,633,380ms, matching `rawWaste.value` exactly. Eyeball against the timeline: the stage's actual wall-clock duration is only 763,776ms, i.e. this run moved shuffle data at ≈267MB/s, roughly 2x the assumed 125MB/s (1Gbps) constant: expected for the fallback tier's deliberately conservative assumption, but worth knowing the modeled figure runs high on fast-network clusters. Under the occupancy model this stage's `gate` is `1`, `ceiling` is `≈434,568.1`ms (434568.1041666667 exactly): `wallClock` capped to `≈329,207.9`ms (329207.8958333333 exactly), since the raw 1,633,380ms claim vastly exceeds the stage's own 763,776ms duration. |
| spill | `diskBytesSpilled / SPILL_IO_THROUGHPUT_BPS` | Same run and stage (99): `diskBytesSpilled`=145,978,433,675 (note: the `SPILL` finding's own `value`/`metric` report `memoryBytesSpilled`=913,686,966,448, ~6x larger; the formula correctly uses the smaller disk figure, not that one) → `wasteMs` = 145978433675 / 200,000,000 × 1000 ≈ 729,892ms, matching `rawWaste.value` exactly. Eyeball: that's ≈191MB/s of implied disk throughput against the stage's 763,776ms actual duration, close to the assumed 200MB/s constant. Same ceiling-clip caveat as the shuffle row above applies here too, on the same stage. |

## Overlap caveat: skew / straggler

`skew` (small-stage max-P50 fallback branch) and `straggler` can both fire on the same
stage from the same single dominant outlier task, and each is clipped independently. This
phase does not dedupe or suppress either: each keeps its own independently-computed
`wallClock`. Do not sum `wallClock.high` across multiple findings on the same stage: if
both fire together, they describe the same underlying waste, not two separate wastes. This
overlap caveat is orthogonal to (and compounds with) the ceiling clip above: a stage with
one dominant outlier task trips both detectors *and* has a small `ceiling`-derived
recoverable room, since `ceiling` is itself `>= taskDurationMax`, the very quantity these
two detectors are reacting to.

`analyzer.ts`'s `flagSkewStragglerOverlap` (run after `deriveImpactBand`, once per `analyze()`
call) surfaces this caveat to the reader instead of leaving it as an internal-only comment:
whenever `skew`'s `max/median` branch and `straggler` both fire on the same `stageId`, it
appends a "this overlaps with the X finding on this stage" sentence to both findings'
`validationRequired` text (rather than suppressing either, so neither finding's own diagnostic
value is lost). `skew`'s `P95/median` branch samples a different task from `straggler`'s own
`taskDurationMax - taskDurationP50` delta, so it's excluded from the flag. The note rides the
same confidence-caveat UI (`RowStatusCluster`) a reader already sees before trusting either
finding's magnitude, since both detectors also carry `confidence: 'low'` (their runtime-floor
thresholds are unvalidated; see the confidence-disclosure note in detector-contract.md).

`stageShape`'s `taskStageSkew` rule no longer participates in this caveat: it reports a
`resourceOnly` idle-core-ms figure (see the coverage table below) instead of a wall-clock
claim, so there's nothing left to double-count against `skew`/`straggler`. Its trigger
condition (`taskDurationMax / stageDurationMs > skewWarn`) mathematically forces the
occupancy-clipped wall-clock estimate to exactly zero on every firing (see `src/detectors.ts`'s
`taskStageSkew` comment), which is why it was moved off the wall-clock path entirely rather
than reconciled against the same ceiling clip as its two siblings above.

## Per-finding-type coverage

One row per distinct `type` string `src/detectors.ts` actually emits (cross-checked
against `computeEstimateForFinding`'s `case` labels in `src/impact-estimator.ts`, not
assumed from the prose here): every row below has a case, so the table itself is the
coverage count, not a number restated here. `broadcastSizing` is a `DETECTORS` entry
label only, and the plan-walk it drives emits `overBroadcast`/`underBroadcast` findings
instead, so those two are the rows that appear, not `broadcastSizing` itself. Tag
meanings: `measured` and `modeled` both produce a real, gate-clipped, non-`{0,0}`
`wallClock` (the difference is whether the formula's inputs are recorded per-stage fields or
an assumed constant like a throughput figure); `cost-only` always reports `basis:
'resourceOnly'`, `wallClock: null` but carries its real signal in `rawWaste`;
`informational-only` reports `basis: 'informational'`, `wallClock: null` with no `rawWaste`
at all, since there's nothing quantifiable. A type with more than one tag fires a different
formula per `variant`/`rule` on the same finding type; the basis column says which.

| Finding type | Scope | Tag | Basis |
|---|---|---|---|
| `retryWaste` | stage | measured | `retryWasteMs`, gate-clipped; pre-clip figure kept as `rawWaste` in `ms` |
| `speculationWaste` | stage | measured | `speculationWasteMs`, gate-clipped; pre-clip figure kept as `rawWaste` in `ms` |
| `coldStart` | app | measured | `gapSeconds × 1000`, unclipped, `basis: 'serial'` unconditionally (a pre-first-task gap can't overlap any stage) |
| `gc` | stage | modeled | `jvmGCTime / (executorRunTime / stageDurationMs)`, gate-clipped: the concurrency division is an approximation, not a reconstruction, hence `modeled`; `rawWaste` in `coreMs` is the raw `jvmGCTime` sum before that conversion |
| `skew` | stage | measured | `taskDurationP95` or `Max` minus `P50` (per `metric`), gate-clipped; pre-clip figure kept as `rawWaste` in `ms` |
| `straggler` | stage | measured | `taskDurationMax − taskDurationP50`, gate-clipped |
| `stageShape` | stage | cost-only | all three rules are `estimateMethod: 'measured'`, real per-stage fields, no assumed constant: `'lowParallelism'` → `rawWaste` in `coreMs` (idle cores × stage duration); `'dataExplosion'` → `rawWaste` in `bytes` (`outputBytes − inputBytes`); `'taskStageSkew'` → `rawWaste` in `coreMs` (`max(0, min(totalCores, taskCount) − 1) × (taskDurationMax − taskDurationP50)`, the cores idle during the straggler's tail at achieved concurrency) |
| `slowHost` | stage | measured / informational-only | duration-based variants (`hostMeanRatio`, `durationShare`, `multiDim`+`taskTime`): `value − taskDurationP50`, gate-clipped; byte-based `multiDim` dimensions: no formula yet |
| `duplicatePlanSubtree` | sql | measured | each contributing stage's real wall-clock duration × the redundant fraction `(occurrences − 1) / occurrences`, summed and capped at the finding's own `stageIds` union. `stageIds` is narrowed to the stages that actually ran the duplicated subtree's matched node instances (accumulator-ID evidence resolved onto each `PlanNode` at parse time, see [Stage-ID attribution for Plan Advisor findings](./detector-contract#stage-id-attribution-for-plan-advisor-findings)), falling back to the whole execution's stages only when no matched instance has any accumulator coverage |
| `shuffle` | stage | modeled | `shuffleReadBytes / SHUFFLE_THROUGHPUT_BPS` (assumed ~125MB/s), gate-clipped; `rawWaste` in `bytes` is the measured `shuffleReadBytes` behind it |
| `spill` | stage | modeled | `diskBytesSpilled / SPILL_IO_THROUGHPUT_BPS` (assumed ~200MB/s), gate-clipped; `rawWaste` in `bytes` is `diskBytesSpilled`, which is the number the formula uses and not the `memoryBytesSpilled` the finding's own `metric` displays |
| `stageSlowness` | stage | modeled | stage duration minus the `stageSlowness` detector's own `infoMin` threshold, gate-clipped |
| `partitionSizing` | stage | modeled | `maxPartitionTooBig`/`shufflePartitionSkew`: shuffle-throughput formulas, gate-clipped. `lowShuffleParallelism`: stage duration scaled down by the shortfall between actual and ideal-partition-count task counts (`stageDurationMs × (1 − taskCount / targetTaskCount)`), i.e. the serialized work more partitions would let run concurrently, not the scheduling cost of the tasks you'd add to fix it |
| `tinyTask` | stage | modeled | excess task count over 10% of the stage's actual count, × assumed per-task scheduling overhead, gate-clipped; pre-clip figure kept as `rawWaste` in `ms` |
| `smallFiles` | sql | modeled / cost-only | `excessFileCount × FILE_OPEN_OVERHEAD_MS`, summed and capped over `stageIds`'s union; with no `stageIds` to map to, cost-only with that same figure as `rawWaste` in `ms`. `stageIds` is narrowed the same way (see [Stage-ID attribution for Plan Advisor findings](./detector-contract#stage-id-attribution-for-plan-advisor-findings)); falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `overBroadcast` | sql | modeled / cost-only | `broadcastBytes / BROADCAST_BANDWIDTH_BPS`, summed and capped over `stageIds`'s union; cost-only with `rawWaste` in `ms` when not stage-mappable. `stageIds` is narrowed the same way; falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `underBroadcast` | sql | modeled / cost-only | `smallerSideBytes / BROADCAST_BANDWIDTH_BPS`, summed and capped over `stageIds`'s union; cost-only with `rawWaste` in `ms` when not stage-mappable. `stageIds` is narrowed the same way; falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `memoryUtilization` | app | cost-only / informational-only | Three of the four variants report `rawWaste` in `mbSeconds`: `variant: 'wasteModel'` passes through its own `wastedMBSeconds`; `'idleCores'` uses `idleRateFraction × allocatedMB × peakExecutors × appDurationSeconds`; `'memoryBand'` with `rule: 'heapOverProvisioned'` uses `(allocatedBytes − heap) in MB × appDurationSeconds`. `'memoryBand'` with `rule: 'heapNearCapacity'` is an OOM-risk signal rather than a waste, and the `dataUnavailable` shape has no inputs at all: both informational-only |
| `utilization` | app | cost-only | `rawWaste` in `coreHours`: `(1 − utilizationFraction) × appDurationMs × totalCores / 3.6e6` |
| `coreLocality` | app | cost-only | `rawWaste` in `coreMs`: `nonLocalTaskCount × NETWORK_FETCH_PENALTY_MS` |
| `autoscalingChurn` | app | cost-only | `rawWaste` in `coreHours`: `shortLivedExecutorCount × EXECUTOR_STARTUP_OVERHEAD_MS / 3.6e6` |
| `configAudit` | config | informational-only | a config-drift check standing alone; no waste formula |
| `jobFailureRate` | app | cost-only | `rawWaste` in `coreHours`: `failedJobCount × avgJobDurationMs / 3.6e6` |
| `cachingOpportunity` | app | cost-only | `rawWaste` in `ms`: `totalReadBytes / RE_READ_THROUGHPUT_BPS` |
| `cacheUtilization` | app | cost-only | `rawWaste` in `ms`: uncached-or-spilled bytes `/ RE_READ_THROUGHPUT_BPS`, where the never-cached partitions' bytes are extrapolated from the cached partitions' own average size (`memorySize + diskSize`, over `numCachedPartitions`), plus `diskSize` again for the already-cached-but-on-disk partitions' own re-read cost |
| `stageFailed` | stage | informational-only | no waste formula |
| `failures` | stage | informational-only | no waste formula |
| `incompleteRun` | app | informational-only | no waste formula |
