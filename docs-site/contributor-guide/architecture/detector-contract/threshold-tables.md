# Threshold tables

The threshold tables for every bottleneck detector, and where each finding's impact band comes from.

## Bottleneck thresholds

Every change to a detector entry under `packages/core/src/detectors/` should reference this table.

Every detector entry declares a required `bandPolicy`, and `analyzer.ts` calls `gradeFinding()`
(`packages/core/src/impact-band.ts`) once per finding after `estimateImpact()`:

- `derived`: when the finding's `impactEstimate` carries a `wallClock` estimate, `.impactBand` is set
  purely from `wallClock.high` as a fraction of the app's total duration (`>= 2%` critical,
  `>= 0.5%` warning, else info: `IMPACT_FLOOR_PCT_CRIT`/`IMPACT_FLOOR_PCT_WARN`, which `skew`'s
  `floorPctWarn` and `straggler`'s `floorPctWarn`/`floorPctCrit` default to, so a tail those gates admit
  grades at least warning; a tuned `skew` or `straggler` floor also grades that entry's own findings,
  see [Tuning thresholds](../detector-contract.md#tuning-thresholds)). For these rules, the table
  below documents their firing gate plus their fixed fallback constant, which surfaces only when this
  run's finding of that type didn't get a wallClock estimate (a stage excluded from the occupancy sweep).
- `own`: the detector's own band stands (`resourceOnly`/`informational` basis, e.g. `configAudit`, or a
  rule that keeps its own ratio-tiered classification, e.g. `failures`). The tiers in
  [Findings that are never wallClock-derived](#findings-that-are-never-wallclock-derived) are the real,
  displayed classification.
- `failure`: the detector's own band stands whatever the stage costs (`stageFailed`, `jobFailureRate`).
  `FAILURE_TYPES` is the set of types whose entry declares it.

An entry can grade one finding under another policy with `gradeAs`: `partitionSizing`'s
`maxPartitionTooBig` rule carries a `wallClock` estimate but is a hardcoded-critical OOM/crash-risk
safety signal, not a time-recovery one, so it grades as `failure` and stays critical however small
that estimate is relative to the run.

`gradeFinding()` then caps a `critical` finding at `warning`, under every policy but `failure`, when
its stage carries under `CRITICAL_MIN_TASK_TIME_SHARE` = 2% of the run's task time. A finding on no
single stage and anything without recorded task time keep `critical`.

### Default thresholds

The table lists, for every finding type, the criterion that fires it and the default thresholds of each detector that emits it. It is generated from the detector catalog, so it always matches the entries in `packages/core/src/detectors/`.

<DetectorThresholds />

### How the gates combine

The generated table holds every number. The notes below name threshold keys only and say how they work together, which the catalog does not carry.

#### Gates that pick the firing condition

- `skew`: the stage's P95 over P50 task duration must exceed `ratioWarn` (the max over P50 for a stage under `minTasksForP95` tasks). P50 is the textbook median, the mean of the two middle values on an even count; P95 stays nearest-rank. The occupancy-clipped tail recovery (`tailRecoveryMs`, `finalizeStage`'s replay of the stage with every slow task capped at P50) must also reach `floorPctWarn` of the app runtime. The clip floors the claim at the longest task the fix leaves and at the core work it leaves over every core. Last, the tail must be data: `tailAttribution` must give the slow tasks' input plus shuffle-read volume at least `dataShareMin` of their extra time. An `unattributed` tail goes to `straggler`.
- `straggler`: fires on a stage with at least `minTasks` tasks that lasts at least `floorPctWarn` of the run, when any speculative task ran, the straggler share exceeds `shareWarn`, or it exceeds `shareWarnAtFloor` with the clipped tail recovery already at `floorPctWarn`. It reads skew's thresholds as resolved for the run (`DetectorCtx.skewThresholds`), not its own: a tail skew's gate admits but data does not explain is reported here without the share test. Tuning `skew` alone never drops a tail from both. `warnPct`/`critPct` and `floorPctWarn`/`floorPctCrit` do not set the band; they rank the straggler and speculative tiers that pick which metric the finding reports. A straggler share has no critical tier of its own.
- `shuffle`, `spill`, `tinyTask`, `duplicatePlanSubtree`, `slowHost` and the low-GC note skip a stage shorter than their `stageFloorPct` (`lowInfoFloorPct` for GC) share of the run, because the claim is clipped to the stage and would grade `info`. A zero-length stage or an unknown run duration passes.
- `partitionSizing`: the skew rule needs `shuffleReadMax` over `skewRatio` times P50 and over `skewFloorBytes`; it is a single-key shuffle when P50 is 0 and the max holds at least `singleKeyShare` of the read. Low parallelism needs `lowParTotalBytes` read by at most `lowParMaxTasks` tasks. `maxPartBytes` flags an oversized partition.
- `gc`: both directions need `minRunTimeMs` of executor run time. The high-GC rule is the warning tier and fires when GC time exceeds `warnPct100` of executor run time. The low-GC note under `lowInfoPct100` is checked only when the high-GC rule did not fire and the log has no measured executor heap peak.
- `slowHost`: every rule first needs `minHosts` hosts or executors, `minTasks` tasks and the stage floor. The mean-duration rule then needs `ratioWarn`, `minShare` of the tasks and `floorMs`; the duration-share rule needs `shareWarn` of the task time and `taskShareWarn` of the tasks.
- `stageSlowness`: the absolute fallback at `infoMin` minutes, suppressed when `slowHost` already fired. The band comes from the partitioning-headroom estimate, not the duration.

#### slowHost multi-dimensional chance test

The multi-dimensional rule compares each executor with the median on task time, input bytes, shuffle bytes and storage memory. A sample must also clear `floorMs` (task time) or `floorBytes` (the byte dimensions). The ratio grades against `ratioTiers`: index 0 is the `info` cut, index 1 `warning` and index 3 `critical`; index 2 is not read.

The task-time dimension also has to pass a chance test, because the slowest of many executors always tops the median. On the log scale of task duration, the executor's mean minus the median executor's mean, over the stage's task spread divided by the root of the executor's task count, must reach √(2 ln(executors ÷ (2 × `outlierAlpha`))). An executor with fewer tasks, or a stage with more executors, needs a larger gap. The spread is rebuilt from each executor's `logDurationSum` and `logDurationM2`. A stage with under two tasks, no spread, or an executor missing either field flags no executor on task time. Of the executors that pass, the one with the largest mean is reported.

The task-time dimension carries a wallClock estimate, so its band is the fixed fallback below until `gradeFinding` replaces it. The byte dimensions never get one and keep their ratio tier.

#### Findings that are never wallClock-derived

These detector entries set `impactBand` themselves, and nothing overwrites it. Each line names the warning key and the critical key.

- `failures`: warning above `warnRate`, critical above `critRate`, on a stage with at least `minTasks` tasks.
- `stageFailed`: always critical when a `stageFailureReason` is present.
- `jobFailureRate`: info from `infoRate`, warning from `warnRate`, critical from `critRate`.
- `autoscalingChurn`: the share of removed executors alive under `shortLivedMs`, warning above `warningPct`, critical above `criticalPct`, with at least `minExecutors` removed.
- `coreLocality`: warning from `warnRatio`, critical from `critRatio`, with at least `minTasks` tasks.
- `cacheUtilization`: partial caching is info under `cachedRatioInfo` and warning under `cachedRatioWarn`; disk spillover (`MEMORY_AND_DISK*` only) is info over `diskRatioInfo` and warning over `diskRatioWarn`. Storage unobserved is a single info caveat for persisted RDDs with no block-update evidence.
- `stageShape`: info only. PRatio fires under `pRatioMax` tasks per core on a stage at least `lowParallelismFloorPct` of the run; OIRatio over `oiRatioMax` output per input byte; TaskStageSkew when the longest task spans over `stageShareMin` of the stage and runs over `skewWarn` times the median, on a multi-task stage at least `taskStageSkewFloorPct` of the run. The median gate is needed because on a single wave of even tasks the longest task spans the whole stage too.
- `utilization`: always warning under `minUtil` busy over allocated core time. The verdict's idle note and the Scorecard's Unused core time flag read the same idle share: notable from `1 - minUtil` idle, critical from `1 - criticalUtil` idle.
- `memoryUtilization`: idle cores warning above `idleCoreWarn`; the memory band is an info over-provisioning note under `bandTooHigh`. It has no near-capacity band, since heap used counts uncollected garbage.
- `rightSizing`: always warning and low confidence. It needs a run peak of at least `minBaselineCores` cores, and fires when the smallest core count whose modeled stage time stays within `tolerancePct` of the observed one is at most `maxCoreShare` of that peak. It stays silent when the model error at the peak exceeds `maxModelErrorPct`.
- `cachingOpportunity`: a single info tier. It fires when the same input relation, or join or union subtree, is scanned by at least `minExecutions` SQL executions in one run.
- `speculationWaste`: always warning, with at least `minWasted` losing speculative copies wasting at least `minWasteMs` of core time. It is cost-only: losing copies run on spare slots beside their originals, so it has no wallClock estimate.
- `configAudit`: `spark.executor.memoryOverhead` below the larger of the minimum and the factor times executor memory is info. The minimum is `spark.executor.minMemoryOverhead` on Spark 4+, else `floorMB`; the factor is `spark.executor.memoryOverheadFactor` on Spark 3.3+, else `floorPct`.

### Fixed fallback bands

These rules have no *band* tiers in `packages/core/src/detectors/` (`gradeFinding` sets a `derived` entry's band whenever a wallClock estimate is available); the band in the table is only a floor-case fallback. A straggler share has no critical tier of its own.

| Rule | Fallback band |
|---|---|
| Task skew | `warning` |
| Shuffle read | `info` |
| Partition sizing: skew | `warning` |
| Partition sizing: low parallelism | `warning` |
| Partition sizing: oversized partition | `critical` |
| GC | `warning` |
| GC (low / cost) | `info` |
| Spill | `warning` |
| Cold start | `warning` |
| Slow host: mean-duration ratio | `warning` |
| Slow host: duration-share | `warning` |
| Slow host: multi-dimensional, task-time dimension | `info` |
| Stage slowness: absolute fallback, suppressed when `slowHost` already fired | `info` |
| Straggler / speculative-execution | `info` |
| Retry waste | `warning` |
| Tiny tasks | `info` |
| Duplicate plan subtree | `warning` |
| Small files read/write | `warning` |
| Nested loop join | `info` |
| Join key cast | `info` |
| MERGE rewrite | `info` |
| Unpruned scan | `info` |
| Python UDF | `info` |
| Broadcast sizing: missed | `info` |
| Broadcast sizing: oversized | `warning` |

#### Spill magnitude tiers

The spill row's band is a fixed `warning` fallback, but `computeSpillMagnitude`
(`packages/core/src/detectors/spill/detect.ts`) runs on every spill finding and sets its
`spillMagnitude` field, which the Spill widget displays. Its tiers, in
evaluation order (first match wins, `null` when nothing matches):

| Condition | Magnitude |
|---|---|
| Single-task stage: `spillDiskMax ≥ singleTaskDiskGiB` **or** `spillMemMax ≥ singleTaskMemGiB` | `severe` |
| Multi-task stage: `spillDiskMax ≥ highDiskGiB`, **or** `spillDiskMax / taskCount ≥ highTaskDiskMB` (per-task proxy), **or** `spillMemMax ≥ highMemGiB` | `high` |
| Multi-task stage: `spillDiskMax ≥ medDiskMB` **or** `spillMemMax ≥ medMemGiB` | `medium` |
| Skew (`taskCount ≥ skewMinTasks`): `spillDiskMax / spillDiskP50 > skewRatio` **and** `spillDiskMax ≥ skewDiskFloorMB` | `high` |
| Skew (`taskCount ≥ skewMinTasks`): `spillMemMax / spillMemP50 > skewRatio` **and** `spillMemMax ≥ skewMemFloorMB` | `medium` |

Disk spill is weighted worse than memory spill by design: the memory
thresholds sit well above their disk counterparts at every tier.

The finding also reports `spillToInputRatio`, the memory spill over `inputBytes`
plus `shuffleReadBytes`, and sets `wideRows` from `wideRowRatio`. A stage
with under `wideRowMinInputMB` of input gets no ratio. Neither
threshold changes the band or the magnitude.

A volume spill adds a `spark.executor.cores` fix when `peakExecutionMemoryMax`
is at least `peakNearShareRatio` of the execution memory per task slot.

### Cache and spill notes

The RDD Info cache figures on stage events (`Number of Cached Partitions`,
`Memory Size`, `Disk Size`) are always 0 since Spark 2.3; Spark 1.x fills them
only on `StageCompleted`. Real cache evidence is `SparkListenerBlockUpdated`,
written only with `spark.eventLog.logBlockUpdates.enabled=true`
(`recordBlockUpdate` in `event-handlers.ts`); the corpus
`cache-memory-only`/`cache-memory-and-disk` logs carry it. Count a block's
sizes only where its storage level says it lives: a drop to disk still reports
the dropped bytes as `Memory Size`.

Spill classification: ≥80% tasks with zero spill → `skew`; <20% zero →
`volume`; else `unclassified`. The classification badge is always shown in
both compact and expanded spill widget states. This is independent of the
magnitude tiers above: classification says *what kind* of spill, magnitude
says *how much*.

#### Evidence fields (`stageFailed` / `retryWaste`)

Beyond a scalar `metric`/`value`, both entries' `detect()` attach to the
finding:

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
informative failure elsewhere in the stage is ever sampled.

#### Evidence fields (`failures`)

- `dominantReason`: the most frequent end-reason tag (`ExceptionFailure`,
  `ExecutorLostFailure`, ...) among tasks still failed at finalize.
- `dominantError`: the error behind that tag, from its largest failure group:
  the exception class, or `<tag>: <loss reason>`; falls back to the tag. The
  recommendation names it and never embeds a message.
- `failureGroups`: up to 5 `TaskFailureGroup`s (`reason`, `className`,
  `message`, `lossReason`, `stackExcerpt`, `count`), most frequent first: one
  group per distinct tag, class, message and loss reason, one excerpt each.
- `otherFailedTasks`: failed tasks that no shown group covers.

`packages/core/src/task-failure.ts` reads the details from `Task End Reason`
(`Class Name`, `Description`, `Full Stack Trace`, `Loss Reason`, FetchFailed
`Message`, `Kill Reason`) and bounds them at ingest: a message or loss reason
to its first line (for a Python traceback, its final error line), 300
characters; an excerpt to the header, 8 frames, a Python traceback's error line
and the last `Caused by:` line, 2000 characters in all. While parsing, a stage keeps at
most 50 distinct failures (`StageRecord.failureDetails`, freed at finalize);
later ones count only toward the tag. Redaction (`redact.ts`) replaces every
`failureGroups[].message` and strips message text from `stackExcerpt`.

### Threshold sources

Where each threshold that is not read from Spark's own source comes from.

| Threshold | Source status |
|---|---|
| `IMPACT_FLOOR_PCT_WARN` = 0.5% and `IMPACT_FLOOR_PCT_CRIT` = 2% (`impact-band.ts`), and every runtime floor that defaults to them or to 0.5% (`floorPctWarn`, `floorPctCrit`, `stageFloorPct`, `lowInfoFloorPct`, `lowParallelismFloorPct`, `taskStageSkewFloorPct`) | Our own noise floors, unvalidated |
| `CRITICAL_MIN_TASK_TIME_SHARE` = 2% (`impact-band.ts`) | `IMPACT_FLOOR_PCT_CRIT` applied to a stage's share of the run's task time. Our own noise floor, unvalidated |
| `SPILL_TASK_TIME_SHARE_PER_PASS` = 50% and `SPILL_TASK_TIME_SHARE_MAX` = 60% (`impact-model.ts`) | Share of a stage's task time one pass of its read bytes through disk spill costs in serialization and sort CPU, and the cap. Measured on local sort stages, where one full pass cost 34-56% of the stage's time |
| `skew` `dataShareMin` = 0.5 | Our own majority cut |
| `gc` `minRunTimeMs` = 10 s | Our own noise floor, so a stage that barely ran flags in neither direction |
| `gc` `warnPct100` = 10 and `lowInfoPct100` = 5 | Carried over unchanged from an external GC heuristic |
| `memoryUtilization` `idleCoreWarn` = 0.50 | Carried over from an external wasted-cores heuristic |
| `rightSizing` `tolerancePct`, `maxCoreShare`, `minBaselineCores` and `maxModelErrorPct` | Our own cuts; the model they gate is idealized. In the corpus gate, 65 of the 66 public logs have an application end, 9 hold a peak of 8 or more cores (3 with dynamic allocation), 1 of those 9 has a model error at or under 20%, and no log fires the finding. Only 2 logs remove an executor. No corpus log fires or misfires at the cuts, and the corpus has too few large, dynamic-allocation or executor-churn runs to tune them |
| `memoryUtilization` `wasteBufferMultiplier` = 1.5 | Unverified buffer |
| `unprunedScan` `minBytesRead`, `minPartitionsRead` | Our own cuts. The public Delta corpus logs scan small partitioned tables, so no default finding fires on them; the rule is tested on them with `minBytesRead` set to 0, and on synthetic plans |
| `mergeRewrite` `minCopiedRows`, `minCopiedToChangedRatio`, `minTargetFiles`, `minFilesKeptShare` and `maxTouchedPartitionShare` | Our own cuts. The public corpus MERGE logs rewrite 2.7 times the rows they change and keep every target file, on a target with 4 partitions. No public log has skipping that fails on a partitioned target, so `weakSkipping` is checked on synthetic plans only |
| `joinKeyCast` has no thresholds | The pattern is the signal; it is always `info` because a cast between small integer types is harmless |
| `nestedLoopJoin` `minOutputRows` = 1,000,000 and `minExpansion` = 10 | Our own noise floors; the stage time the finding is graded on decides how much it matters |
| `pythonUdf` `minBytesSent` and `minStageMs` | Conservative guesses, not tuned against a real workload |
| The assumed throughputs and overheads in `impact-model.ts` | Starting assumptions, unvalidated |

### Spark defaults by release

`sparkConfDefault()` (`packages/core/src/spark-conf.ts`) answers a property's default for the
run's Spark version from this table. A property introduced by a release has no default before it.

| Property | Default | From |
|---|---|---|
| `spark.speculation.multiplier` | 1.5, then 3 | 4.0.0 |
| `spark.speculation.quantile` | 0.75, then 0.9 | 4.0.0 |
| `spark.sql.adaptive.enabled` | false, then true | 3.2.0 |
| `spark.sql.adaptive.skewJoin.enabled`, `spark.sql.adaptive.coalescePartitions.enabled` | true | 3.0.0 |
| `spark.sql.adaptive.skewJoin.skewedPartitionFactor` = 5, `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` = 256MB | A partition is skewed above both the factor times the median partition and the threshold | 3.0.0 |
| `spark.sql.adaptive.forceOptimizeSkewedJoin` | false; true accepts the extra shuffle a split can cost | 3.3.0 |
| `spark.sql.adaptive.advisoryPartitionSizeInBytes` | 64MB (falls back to `spark.sql.adaptive.shuffle.targetPostShuffleInputSize`) | 3.0.0 |
| `spark.sql.adaptive.coalescePartitions.parallelismFirst` | true; AQE then sizes merged tasks from `defaultParallelism` too, so a larger advisory size alone does not merge more | 3.2.0 |
| `spark.executor.memoryOverheadFactor` | 0.1 (0.4 for Kubernetes non-JVM jobs, which the log does not tell apart); overhead is max(factor x executor memory, minimum) when `spark.executor.memoryOverhead` is unset | 3.3.0 |
| `spark.executor.minMemoryOverhead` | 384m | 4.0.0 |
| `spark.sql.execution.pythonUDF.arrow.enabled` | false, then true | 3.4.0 (introduced), 4.2.0 (on) |

The remaining keys in the table (`spark.speculation`, `spark.executor.memory`, `spark.serializer`,
`spark.shuffle.service.enabled`, `spark.locality.wait`, the `spark.eventLog` switches, the
dynamic-allocation bounds, `spark.sql.shuffle.partitions`, `spark.sql.autoBroadcastJoinThreshold`,
`spark.sql.files.maxPartitionBytes`) have one default on every release.

### Calibration data

Calibrated on 14 real logs. Each figure counts findings or groups the default thresholds
produce on them. A 0.5% runtime floor drops findings on stages that barely ran, where the claim
is clipped to the stage and would grade `info`; the condition is still true there.

| Detector | Calibration figure |
|---|---|
| `duplicatePlanSubtree` | 270 of 546 duplicate groups differ beyond AQE query-stage numbers (`occurrencesIdentical: false`); 340 of 545 findings sit on repeats whose stages are shorter than the floor; a WholeStageCodegen wrapper or an Exchange write half is the only operator outside the subtree on 426 stages |
| `stageShape` (`lowParallelism`) | 2,839 of 3,005 findings fall under the floor, 2,168 of them on sub-second stages |
| `shuffle` | 182 of 284 findings fall under the floor |
| `spill` | 12 of 38 findings fall under the floor, all `info` |
| `gc` (low GC) | 464 of 685 low-GC notes fall under the floor (701 `gc` findings in all) |
| `slowHost` | 324 of 452 findings fall under the floor, all `info` |
| `straggler` | 671 of 753 findings fall under the floor, none above `info`. Scored against a task-level replay of every stage (recoverable = replay with each task over 4x P50 capped at P50), admitting 2.5-5% shares whose clipped tail already clears `floorPctWarn` finds 3 stages (10-48 s) for 1 borderline miss; admitting every 2.5% share adds 86 findings below the floor |
| `tinyTask` | 132 of 151 findings fall under the floor |
| `coldStart` | The driver's own startup before the first job takes 36-47 s on every log, so the gap is measured from the first stage's submission, not from application start |
