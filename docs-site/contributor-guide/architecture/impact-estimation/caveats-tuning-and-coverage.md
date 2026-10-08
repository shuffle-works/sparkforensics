# Caveats, tuning and coverage

Spot-checks for each estimate formula, the overlap caveat, the effect of tuned thresholds and which finding types have an estimate.

## Per-formula spot-checks

| Detector | Formula basis | Spot-check |
|---|---|---|
| gc | `jvmGCTime / (executorRunTime / stageDurationMs)` | `private-log-01.zstd`, stage 507: `jvmGCTime`=1080ms, `executorRunTime`=27509ms, `stageDurationMs`=56279ms → `wasteMs` = 1080 / (27509/56279) ≈ 2209.5ms. That's ≈3.9% of the stage's 56.3s wall-clock duration, matching the finding's own reported `gcPct` (3.9%) exactly, as the formula guarantees by construction. Under the occupancy model this stage's `gate` is `0.041` (0.04145044590332269 exactly): `basis: 'contended'`, `wallClock: {low: 91.6, high: 2209.5}` (91.5850382272182 / 2209.506706895925 exactly). |
| shuffle | `shuffleReadBytes / (SHUFFLE_THROUGHPUT_BPS × executors that ran the stage)` | `private-log-02.zstd`, stage 99 (`SHFL` finding): `shuffleReadBytes`=204,172,518,504 over 8 executors → `wasteMs` = 204172518504 / (8 × 125,000,000) × 1000 ≈ 204,173ms, against the stage's 763,776ms duration. The tasks' own measured shuffle fetch wait on this stage is 25.2s of wall-clock (`fetchWaitTime` / average concurrency), so even the per-link model runs well above the network stall actually observed, and the claim is capped there: 25.2s, `measured`. |
| spill | `diskBytesSpilled / (SPILL_IO_THROUGHPUT_BPS × executors that ran the stage)` | Same run and stage (99): `diskBytesSpilled`=145,978,433,675 (note: the `SPILL` finding's own `value`/`metric` report `memoryBytesSpilled`=913,686,966,448, ~6x larger; the formula correctly uses the smaller disk figure, not that one) over 8 executors → `wasteMs` = 145978433675 / (8 × 200,000,000) × 1000 ≈ 91,237ms (91236.521046875 exactly, matching `wallClock`, below the clip). |

## Overlap caveat: skew / straggler

`skew` and `straggler` both claim the stage's `tailReplayRecoveryMs` (see
[Occupancy-weighted attribution](../impact-estimation.md#occupancy-weighted-attribution)), whichever skew branch fired,
so when both fire on one stage they report the same recovered tail. The skew branch (P95 or max
over P50) changes only the fallback single-task delta on a stage without the replay field. This
phase does not dedupe or suppress either: each keeps its own independently-computed
`wallClock`. Do not sum `wallClock.high` across multiple findings on the same stage: if
both fire together, they describe the same underlying waste, not two separate wastes. Both
are clipped with the post-fix floor described under
[Occupancy-weighted attribution](../impact-estimation.md#occupancy-weighted-attribution), not the plain `ceiling`,
so a stage gated by one dominant outlier task reports that task's excess as recoverable
instead of the near-zero room `ceiling >= taskDurationMax` would leave.

`analyzer.ts`'s `flagSkewStragglerOverlap` (run after `deriveImpactBand`, once per `analyze()`
call) states this caveat on the findings themselves:
whenever `skew` (either branch) and `straggler` both fire on the same `stageId`, it
appends a "this overlaps with the X finding on this stage" sentence to both findings'
`validationRequired` text (rather than suppressing either, so neither finding's own diagnostic
value is lost). The note rides the
same confidence-caveat UI (`RowStatusCluster`) a reader already sees before trusting either
finding's magnitude, since both detectors also carry a `confidence` field that scales
`low`/`medium`/`high` off how far the finding's own ratio (skew: `ratioWarn`) or task share
(straggler: `shareWarn`/`warnPct`, `critPct`) sits past its detector threshold
(unvalidated; see the confidence-disclosure note in detector-contract.md).

`stageShape`'s `taskStageSkew` rule doesn't participate in this caveat: it reports a
`resourceOnly` idle-core-ms figure (see the coverage table below) instead of a wall-clock
claim, so there's nothing left to double-count against `skew`/`straggler`. It fires on the
same straggler tail those two price (on the corpus, each of its 6 firings shares a stage with a
`skew` or `straggler` finding), which is why it stays off the wall-clock path.

## Tuned thresholds

The estimates are calibrated against the default detector thresholds: the spot-checks above,
the corpus snapshot and the tail-replay scores (`dev/eval-tail-replay.mjs`) all measure
findings the defaults produce. The formulas read the stage's own figures, not the thresholds,
but a threshold decides which findings exist, so an override that loosens one produces
findings, near its new gate, that no estimate here was checked against. When the CLI or the
MCP server runs with `--thresholds` (see
[Tuning thresholds](../detector-contract.md#tuning-thresholds)), every finding from a tuned
detector carries `tunedThresholds`, a finding with an estimate figure gets a
`validationRequired` sentence saying that estimate is unvalidated, and the report header lists
the tuned detectors. The estimate itself is computed the same way; nothing rescales or drops it.
The impact bands (`impact-band.ts`) keep their default floors on a tuned run, except that a
tuned `skew` or `straggler` `floorPctWarn`/`floorPctCrit` grades that entry's own findings.

## Per-finding-type coverage

One row per distinct `type` string `packages/core/src/detectors.ts` actually emits: every
entry must declare an `estimate()` (the compiler rejects one without it), so every row below
has one, and the table itself is the coverage count, not a number restated here. `broadcastSizing` is a `DETECTORS` entry
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
| `retryWaste` | stage | measured / modeled | `retryWasteMs` is summed attempt time, and attempts of different tasks run side by side (one lost executor fails every task it was running at once). With every wasted attempt sampled (`retryTaskSamples`, capped at 20), modeled: the longest retry chain (highest sampled attempt number + 1) times the mean wasted attempt, or `retryWasteMs / peakConcurrentTasks` when larger, capped at `retryWasteMs`. Otherwise measured, `retryWasteMs` itself. Gate-clipped; the summed figure is kept as `rawWaste` in `ms`. |
| `speculationWaste` | stage | measured | `speculationWasteMs`, gate-clipped; pre-clip figure kept as `rawWaste` in `ms` |
| `coldStart` | app | measured | `gapSeconds × 1000` (first stage submitted to first executor added), unclipped, `basis: 'serial'` unconditionally (a pre-first-task gap can't overlap any stage) |
| `gc` | stage | modeled / informational-only | high-GC: `jvmGCTime / (executorRunTime / stageDurationMs)`, gate-clipped: the concurrency division is an approximation, not a reconstruction, hence `modeled`; `rawWaste` in `coreMs` is the raw `jvmGCTime` sum before that conversion. Low-GC (`direction: 'low'`): informational-only, since its fix (less executor memory) raises GC rather than recovering it |
| `skew` | stage | measured | `tailRecoveryMs`: the stage's `tailReplayRecoveryMs` (a task-level replay with every task over 4× P50 capped at P50), gate-clipped against the post-fix floor (`shortensLongestTask`) with the longest task the fix leaves as a floor (`longestTaskAfterFixMs`, as for `straggler`); pre-clip figure kept as `rawWaste` in `ms` |
| `straggler` | stage | measured | `tailRecoveryMs`, as for `skew` (0 on a speculation-driven stage with no task over 4× P50), gate-clipped against the post-fix floor (`shortensLongestTask`, `longestTaskAfterFixMs`) |
| `stageShape` | stage | cost-only | all three rules are `estimateMethod: 'measured'`, real per-stage fields, no assumed constant: `'lowParallelism'` → `rawWaste` in `coreMs` (idle cores × stage duration); `'dataExplosion'` → `rawWaste` in `bytes` (`outputBytes − inputBytes`); `'taskStageSkew'` → `rawWaste` in `coreMs` (`max(0, min(totalCores, taskCount) − 1) × (taskDurationMax − taskDurationP50)`, the cores idle during the straggler's tail at achieved concurrency; `totalCores` here is the finding's own figure: the executors that ran the stage × `spark.executor.cores`, not the run's peak concurrent cores) |
| `slowHost` | stage | measured / informational-only | duration-based variants: the slow host's absolute figure minus the stage median, `max(0, hostMeanMs − taskDurationP50)` for `hostMeanRatio`/`durationShare` and `max(0, execMaxValue − taskDurationP50)` for `multiDim`+`taskTime` (`value` is a ratio or share, never ms), gate-clipped, pre-clip figure kept as `rawWaste` in `ms`; byte-based `multiDim` dimensions: no formula yet (`estimateMethod: 'none'`) |
| `duplicatePlanSubtree` | sql | measured | per stage in `stageShares`: its task-active time (`taskActiveMs`, the union of its task intervals; submit-to-complete only when absent) × the repeated operators' share of that stage × the redundant fraction `(occurrences − 1) / occurrences`, summed and capped at the union of those stages' spans. A stage shared with other operators (the consuming join, the other join side) contributes only its share, so sibling groups can't claim one stage twice, and a stage left waiting for cores (2491 s open, 60 s of tasks on a real log) claims only its task time. No claim (`informational`) when the repeats' details differ (`occurrencesIdentical: false`) or no repeated operator has a stage (the execution-wide `stageIds` fallback stays for linking only). |
| `shuffle` | stage | modeled / measured | `shuffleReadBytes / (SHUFFLE_THROUGHPUT_BPS × executors)` (assumed ~125MB/s per executor link; `executors` = `executorStats.length`, the executors that ran the stage, min 1), capped at the fetch wait the tasks measured in wall-clock (`fetchWaitTime / (executorRunTime / stage duration)`, the `gc` conversion; `measured` when that cap binds), gate-clipped; `rawWaste` in `bytes` is the measured `shuffleReadBytes` behind it. The link model can't see whether reads stalled the tasks, which is why the fetch-wait cap applies. Fetch wait misses disk reads and deserialization, so the cap is a floor on what a shuffle costs, not its total |
| `spill` | stage | modeled | `diskBytesSpilled / (SPILL_IO_THROUGHPUT_BPS × executors)` (assumed ~200MB/s per executor's local disk, same executor count as `shuffle`), gate-clipped; `rawWaste` in `bytes` is `diskBytesSpilled`, which is the number the formula uses and not the `memoryBytesSpilled` the finding's own `metric` displays |
| `stageSlowness` | stage | modeled | what more partitions (the finding's recommendation) could recover: the stage's task-active time (`taskActiveMs`, the union of its tasks' launch-to-finish intervals from `finalizeStage`) × `max(0, 1 − taskCount / totalCores)`, gate-clipped with the post-fix floor (`shortensLongestTask`: splitting partitions splits the longest task too). A stage that already ran at least as many tasks as the cluster had cores claims 0, and so does one that read no input and no shuffle bytes and whose tasks spent under 1% of `executorRunTime` on CPU (`executorCpuTime`): they sat waiting on something outside Spark, which more partitions don't split (a 1-task JDBC `count` stage open 27 minutes on 5s of CPU, 0.33%, claims 0). Non-Python stages under 1% CPU share are JDBC reads, file listings and Delta log reads, and file writes start at 2%. The share is skipped, keeping the claim, when the log records no CPU time (older Spark) or the stage ran Python through `PythonRDD`, whose worker CPU the JVM metric misses (0.1% on computing stages); a Python UDF inside a SQL stage that reads no bytes isn't detected and can still read idle. A stage that read input or shuffle bytes keeps its claim whatever its CPU share, so a Python UDF over real input is never zeroed. Time a stage sat open with no task running (queued for slots) claims nothing. No cluster core count: informational. |
| `partitionSizing` | stage | modeled | `maxPartitionTooBig`/`shufflePartitionSkew`: shuffle-throughput formulas, gate-clipped. `lowShuffleParallelism`: stage duration scaled down by the shortfall between actual and ideal-partition-count task counts (`stageDurationMs × (1 − taskCount / targetTaskCount)`), i.e. the serialized work more partitions would let run concurrently, not the scheduling cost of the tasks you'd add to fix it. The claim shortens the longest task, so it is capped at the reduction of that task (`taskDurationMax − longestTaskAfterFixMs`, with `longestTaskAfterFixMs = taskDurationMax × taskCount / targetTaskCount`, the longest task after an even split: a modeled figure, optimistic when `shufflePartitionSkew` fires on the same stage) and gate-clipped with the post-fix floor (`shortensLongestTask`). `coreTimeMs` is null: the figure is wall-clock, not removed task time |
| `tinyTask` | stage | measured / modeled | excess task count over 10% of the stage's actual count, × the stage's own measured per-task overhead (summed task wall time from `executorStats` minus `executorRunTime`, over `taskCount`), ÷ the stage's achieved task concurrency (task time ÷ stage duration, floored at 1), gate-clipped; `measured`. A stage with no `executorStats` or no measurable overhead falls back to the assumed 50ms per task, undivided (`modeled`). Pre-clip figure kept as `rawWaste` in `ms`. |
| `smallFiles` | sql | modeled / cost-only | `fileCount × FILE_OPEN_OVERHEAD_MS` (10 ms per file), divided for a read by the most tasks its stages ran at once (`peakConcurrentTasks`: tasks open their files in parallel; 91,344 files claimed 76 s on a 117 s stage that ran 314 tasks at once) and kept serial for a write (the job commit moves each file on the driver). The figure is split evenly across `stageIds`, each stage's share is gate-clipped, and the sum is capped at the stages' union; with no `stageIds` to map to, cost-only with that same figure as `rawWaste` in `ms`. `stageIds` is narrowed the same way (see [Stage-ID attribution for Plan Advisor findings](../detector-contract/plan-attribution.md#stage-id-attribution-for-plan-advisor-findings)); falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `overBroadcast` | sql | modeled / cost-only | `broadcastBytes / BROADCAST_BANDWIDTH_BPS`, summed and capped over `stageIds`'s union; cost-only with `rawWaste` in `ms` when not stage-mappable. `stageIds` is narrowed the same way; falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `underBroadcast` | sql | modeled / cost-only | `smallerSideBytes / BROADCAST_BANDWIDTH_BPS`, summed and capped over `stageIds`'s union; cost-only with `rawWaste` in `ms` when not stage-mappable. `stageIds` is narrowed the same way; falls back to the whole execution's stages when the flagged node(s) have no accumulator coverage. |
| `memoryUtilization` | app | cost-only / informational-only | Three of the four variants report `rawWaste` in `mbSeconds`: `variant: 'wasteModel'` passes through its own `wastedMBSeconds`; `'idleCores'` uses `idleRateFraction × allocatedMBSeconds`, with `idleRateFraction` measured against the same allocated core time as `utilization` and `allocatedMBSeconds` the run's allocated memory-seconds from `computeAllocation()` (executor heap plus overhead over each executor's alive time; Spark's defaults when the memory properties are not logged); `'memoryBand'` with `rule: 'heapOverProvisioned'` uses `(allocatedBytes − heap) in MB × executorSeconds`, the seconds the run's executors were alive. The `dataUnavailable` shape has no inputs at all: informational-only |
| `utilization` | app | cost-only | `rawWaste` in `coreHours`: `(1 − utilizationFraction) × allocatedCoreMs / 3.6e6`, where `allocatedCoreMs` is cores × time alive over every executor (`allocatedCoreMs()`, the figure behind `metrics.allocation.coreHours`), so it never exceeds the allocation. The same figure in core-milliseconds is `idleCoreTimeMs` |
| `coreLocality` | app | cost-only | `rawWaste` in `coreMs`: `nonLocalTaskCount × NETWORK_FETCH_PENALTY_MS` |
| `autoscalingChurn` | app | cost-only | `rawWaste` in `coreHours`: `shortLivedExecutorCount × EXECUTOR_STARTUP_OVERHEAD_MS / 3.6e6` |
| `pythonUdf` | sql | informational-only | no waste formula: the gain from Arrow-optimized or pandas UDFs depends on how much of the stage is the UDF body, which the log does not record |
| `configAudit` | config | informational-only | a config-drift check standing alone; no waste formula |
| `jobFailureRate` | app | cost-only | `rawWaste` in `coreHours`: `failedJobCount × avgJobDurationMs / 3.6e6` |
| `cachingOpportunity` | app | cost-only | `rawWaste` in `ms`: `totalReadBytes / RE_READ_THROUGHPUT_BPS` |
| `cacheUtilization` | app | cost-only | `rawWaste` in `ms`: uncached-or-spilled bytes `/ RE_READ_THROUGHPUT_BPS`, where the never-cached partitions' bytes are extrapolated from the cached partitions' own average size (`memorySize + diskSize`, over `numCachedPartitions`), plus `diskSize` again for the already-cached-but-on-disk partitions' own re-read cost. The `storageUnobserved` caveat (`dataUnavailable`) has no sizes: informational-only |
| `stageFailed` | stage | informational-only | no waste formula |
| `failures` | stage | informational-only | no waste formula |
| `incompleteRun` | app | informational-only | no waste formula |
