# Impact estimation

Every finding covered by this section carries an optional `impactEstimate: {basis,
wallClock, estimateMethod, rawWaste?, coreTimeMs?}` (`packages/core/src/types.ts`), attached by
its `DETECTORS` entry's `estimate()` (`packages/core/src/detectors.ts`), which
`estimateImpact()` (`packages/core/src/impact-estimator.ts`) runs as a post-pass once detection
and suppression finish (`packages/core/src/analyzer.ts`). The waste models those methods compose
(assumed throughputs, per-stage measurements, the occupancy clip wrappers) live in
`packages/core/src/impact-model.ts`, and `analyze()` builds the one `EstimateCtx`
(`stages`, `occupancy`, `totalCores`) every `estimate()` and every detector's runtime floor reads.
`estimateMethod` ('measured' | 'modeled' | 'none') is a distinct axis from the per-finding
`confidence` field ([Confidence metadata](./board-widgets.md#confidence-metadata)):
`confidence` says how much to trust the finding itself,
`estimateMethod` says how its impact number was derived. `'none'` marks a purely
informational finding with no waste model at all (`configAudit`, `stageFailed`,
`failures`, `incompleteRun`, `slowHost`'s byte-dimension multiDim shapes, `gc`'s low-GC
direction, `cacheUtilization`'s `storageUnobserved` caveat, `duplicatePlanSubtree` when its
repeats differ or map to no stage): it's distinct
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

`rawWaste` is not exclusive to `resourceOnly`/`informational` findings: every `serial`/
`contended` finding carries it too (the only exceptions are `coldStart`, whose `wallClock`
figure is already unclipped, and `estimateMethod: 'none'` findings, which have no formula at
all), holding the formula's pre-clip magnitude in the formula's own natural unit (ms,
bytes or core-ms). `wallClock` is what the occupancy model says is recoverable, which clips
against the stage's own physical floor; `rawWaste` is what the stage really wasted either
way. The two answer different questions.

`coreTimeMs` is the busy core time the fix removes, the executor task time, as `{low, high}`
core-milliseconds with `low === high`, or `null` when the detector measures none (never 0 for
unknown). `estimateImpact()` sets it for every estimate through `coreTimeFor()` in
`packages/core/src/impact-model.ts`, and only from a measured figure: skew and straggler's
removed task time (`tailClaimImpact()` sets it from the claim's `removedCoreWorkMs`), or the raw
figure of a type in `MEASURED_CORE_TIME_FIGURE`: gc's `jvmGCTime` (`coreMs`) and the cross-task
executor-time `ms` sums of `retryWaste` and `speculationWaste`. These are set even when the log
has no executor cores. A wall-clock claim is never converted to core time, so every finding with
only a wall-clock claim gets `null`. A modeled figure, one that rests on an assumed constant, gets
`null` too: coreLocality's `coreMs` (non-local tasks × `NETWORK_FETCH_PENALTY_MS`) and the
`coreHours` of `autoscalingChurn` and `jobFailureRate`. `estimateMethod` does not decide this,
because it describes the wall-clock figure: gc's is `modeled` while its `jvmGCTime` is read from
the log. `executorCpuTime` is never read because it leaves out Python worker CPU.

Every surface reads `coreTimeMs` and `remediation` from the one `analyze()` result: the dashboard
stores it, the HTML export ships it in its `catalog`, and the CLI report and MCP tools put it in
their finding rows through `buildEvidenceReport()`. `surface-parity.test.js` compares the four on the
public corpus logs.

`coreTimeMs` is busy time only. A `coreMs`/`coreHours` raw figure that counts allocated capacity
no task ran on carries `rawWaste.idle: true`: `utilization` (`coreHours`) and `stageShape`'s
`lowParallelism` and `taskStageSkew` (`coreMs`). `coreTimeFor()` gives those `null`, and
`rawWasteMeaning()` in `packages/core/src/impact-format.ts` labels them "of idle core capacity"
instead of "of core time" on every surface. `memoryUtilization`'s `idleCores` counts `mbSeconds`,
which has no core time either. A stage's slow tail is also counted once: `skew` and `straggler`
both measure the task time removed from it, so on one stage `skew` carries it and `straggler` has
`null` (`countTailCoreTimeOnce()` in `packages/core/src/impact-estimator.ts`).

## Occupancy-weighted attribution

`packages/core/src/occupancy.ts` sweeps every stage's observed `[submittedAt, completedAt)` window and
splits each instant's wall-clock among concurrently-active stages proportional to
`coreWeight(S) = stage.executorRunTime / stageDurationMs` (an average-concurrency proxy,
held constant across the stage's whole window: this codebase has no per-task timestamps
outside the parser worker to do better). Summing a stage's share across its own window
gives its `occupancy(S)`; `gate(S) = occupancy(S) / duration(S) ∈ [0, 1]` is the single
number the estimate reads.
1.0 means the stage ran completely alone; 0 means the stage had zero `executorRunTime`
while overlapping other, positive-weight stages, so it got no share of the shared window.
When every stage active over an interval has zero weight (no `executorRunTime`), that interval
is split equally among them instead, so a stage that ran alone still gets `gate` 1.
Stages with `duration(S) <= 0` (Spark-skipped stages, or a malformed
`submittedAt === completedAt`) are excluded from the sweep entirely.

`efficiency-model.ts` reports `floorZeroSkewMs` (total task time / peak concurrent cores) as its
theoretical floor.

`ceiling(S) = max(stage.taskDurationMax, stage.executorRunTime / totalCores)` is a physical
floor on a stage's own duration: bounded below by its single longest task (unsplittable no
matter how much parallelism exists) or by its core-work spread across every core in the
cluster, whichever is larger. Every waste formula's raw claim is clipped against it before
gate-weighting: `wasteMs_clipped(S) = min(wasteMs_claimed, max(0, duration(S) - ceiling(S)))`,
so a finding can never claim to save more than the portion of the stage's observed duration
that sits above its own unbeatable floor.

`skew` and `straggler` are the exception (`estimateSingleStage`'s `shortensLongestTask`
option, passed by `detectors.ts`'s `tailClaimImpact`, which both their `estimate()` and their
`detect()` runtime-floor gate call on the same tail claim, so firing and display agree; `stageSlowness`'s
more-partitions estimate passes it too, since splitting partitions splits the longest task). Their claim shortens the
stage's longest task itself, so `taskDurationMax` can't be their floor: clipping against it
would cap a stage gated by one straggler at `duration(S) − taskDurationMax`, about zero, exactly
when the fix recovers the most. Their floor is instead the longest task the fix leaves plus
the core work the fix leaves, `max(taskDurationMax − wasteMs_claimed, longestTaskAfterFixMs,
(stage.executorRunTime − removed) / totalCores)`, where `removed` (`tailRemovedWorkMs`) is the
larger of the finding's single-task delta (see below) and `stragglerExcessMs`, and
`longestTaskAfterFixMs` is the longest task the fix leaves for `skew` and `straggler` (see below). Counting the stragglers' own run time as work
the stage can't shed would floor a stage whose tail is most of its core time near its observed
duration.

The claim itself is `tailRecoveryMs` (`occupancy.ts`), which returns the stage's
`tailReplayRecoveryMs`: `finalizeStage` replays the stage's own tasks with list scheduling
(`computeTailReplayRecoveryMs` in `stage-quantiles.ts`: slots = `peakConcurrentTasks`, at
least 1 and at most the task count; tasks in launch order, equal launch times in task-array
order, each on the slot that frees first) once with the real durations and once with every
task over 4× P50 capped at P50, and takes the difference. It runs only on stages with a task
over 4× P50 (every other stage recovers 0) and costs a launch-order index and a slot heap per
stage: 5-9 ms over the 236 such stages (23,641 tasks) of the largest real log, whose parse
takes 5.5-6.9 s. `dev/eval-tail-replay.mjs` keeps an independent copy of the replay as its
ground truth, and the two agree on every tail stage of the real logs and the corpus.

A stage without the field (one built by hand, as in detector tests) falls back to a
stage-level estimate: the larger of the single-task delta above and
`stragglerExcessMs / peakConcurrentTasks`, the summed excess over P50 of every task slower
than 4× P50, spread over the most tasks the stage ever ran at once. That estimate assumes the
tail either gates the stage through one task or spreads evenly over the slots; the replay
knows when each slow task launched. Stragglers clustered at the end of a stage recover more
than the even spread (one real stage: 12 of 200 tasks over 4× P50 on 29 slots, 89.0s
estimated, 127.3s replayed), a long task launched early overlaps the rest of the stage and
recovers less than its excess (8.4s estimated, 3.0s replayed), and a speculation-driven
stage with no task over 4× P50 recovers nothing (5.8s estimated on two real stages).

The single-task deltas set the removed work above and the fallback estimate.
`straggler`'s runs from `taskDurationMax` down to the longest task its fix
leaves (`stragglerFixLongestTaskMs`), not down to P50: the fix brings every task over 4× P50 to
the median, so the stage still waits on its longest task at or under that
(`longestNonStragglerMs`, from `finalizeStage`), and that task is also passed as a floor
(`longestTaskAfterFixMs`). A speculation-driven finding with no task over 4× P50 keeps the P50
delta. `skew` keeps its P50 delta, since repartitioning may even out tasks under 4× P50 too,
but takes the same `longestTaskAfterFixMs` floor: without it a 100 s stage whose next-longest
task ran 39 s would have skew claiming 90 s where straggler claims 61 s.

`analyzer.ts` feeds this `totalCores` from `packages/core/src/core-count.ts`'s
`computePeakConcurrentCores(app, executorsAdded, executorsRemoved)` (the same peak concurrent
capacity `efficiency-model.ts`, `wasted-core-hours.ts` and the `utilization`/`memoryUtilization`
detectors use), not `computeTotalCores`, which only `scaling-sim.ts` uses. `computeTotalCores` sums every `ExecutorAdded` event's cores
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
`executorsAdded.length × cores`, which overcounts under churn.

Per-finding estimate, using `wasteMs_clipped(S)`:

- `gate(S) >= 0.999`: `basis: 'serial'`, `low = high = wasteMs_clipped(S)`.
- `gate(S) < 0.999`: `basis: 'contended'`, `high = wasteMs_clipped(S)`,
  `low = wasteMs_clipped(S) * gate(S)`.

A finding spanning multiple stages (`stageIds`, plural) sums each stage's own estimate and
caps the joint total at the union of just that finding's own stage windows (via
`mergeIntervals`, `packages/core/src/intervals.ts`): `high = min(Σ high_i, unionMs(stageIds))`,
`low = min(Σ low_i, unionMs(stageIds))`. This is what prevents overclaiming when two or more
of a finding's stages overlap in wall-clock time: a plain sum-and-cap.
The union cap can force `low === high` numerically even when the constituent stages were
individually contended (e.g. two fully-overlapping stages each at `gate` 0.5), so `basis`
isn't derived from that numeric equality: a multi-stage finding gets `basis: 'serial'` only
when every one of its per-stage estimates was itself `'serial'`; otherwise `'contended'`.

Regression guard: a finding whose stage (or, for a multi-stage finding, every one of its
stages) ran alone (`gate >= 0.95`, deliberately looser than the `0.999` "serial" cutoff
above: this guard exists to catch egregious false zeros, not to gate which `basis` a finding
gets) with a real underlying magnitude (`rawWaste.value > 0`) must never report
`wallClock.high === 0` or `basis: 'informational'/'resourceOnly'`. Covered by
`packages/core/test/impact-estimator-real-log.test.js` (run with `npm run test:core`; skipped
unless the `private-log-01.zstd` fixture is in `examples/`); relies on `rawWaste` being
attached to every serial/contended-capable formula (see above), so it's blind to `coldStart`,
the purely informational (`estimateMethod: 'none'`) finding types, `stageShape` (resourceOnly
by design) and `shuffle` findings whose stage measured zero fetch wait (a measured zero, not a
clip artifact).

Real-log spot-check (`private-log-01.zstd`): median `gate` across stages was
`≈0.34` (0.3428060791718594 exactly); `collectRun` plus the occupancy sweep together took
`≈6,589`ms on the largest fixture measured
(`private-log-03.zstd`, `1169` stages):
parse-dominated, the sweep alone was not isolated by this measurement, but not a magnitude
that suggests a regression either.
