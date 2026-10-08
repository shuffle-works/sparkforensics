# Threshold tables

The threshold tables for every bottleneck detector, and where each finding's impact band comes from.

## Bottleneck thresholds

Every change to `packages/core/src/detectors.ts` should reference this table.

Every finding's `impactBand` comes from one of two places. For any finding
whose `impactEstimate` carries a `wallClock` estimate (the common case for
most rules below), `analyzer.ts` calls `deriveImpactBand()`
(`packages/core/src/impact-band.ts`) immediately after `estimateImpact()`, which sets
`.impactBand` purely from `wallClock.high` as a fraction of the app's total
duration (`>= 2%` critical, `>= 0.5%` warning, else info: `IMPACT_FLOOR_PCT_CRIT`/
`IMPACT_FLOOR_PCT_WARN`, which `skew`'s `floorPctWarn` and `straggler`'s
`floorPctWarn`/`floorPctCrit` default to, so a tail those gates admit grades
at least warning; a tuned `skew` or `straggler` floor also grades that
entry's own findings, see [Tuning thresholds](../detector-contract.md#tuning-thresholds)). For those rules, the table below documents their firing
gate plus their fixed fallback constant, which surfaces only when this run's
finding of that type didn't get a wallClock estimate (a stage excluded from
the occupancy sweep). For rules whose finding type never gets
a wallClock estimate (`resourceOnly`/`informational` basis, e.g.
`configAudit`, or a rule that keeps its own ratio-tiered classification,
e.g. `failures`), the full threshold table below is
the real, displayed classification: `detectors.ts` sets `impactBand`
directly and nothing overwrites it. `partitionSizing`'s `maxPartitionTooBig`
rule is a third case: it does carry a `wallClock` estimate but is explicitly
exempted in `deriveImpactBand()` because it's a hardcoded-critical OOM/crash-risk
safety signal, not a time-recovery one, so `detectors.ts`'s own classification
stands regardless of how small that estimate is relative to the run.

### Fixed fallback only (usually wallClock-derived instead)

These rules have no *band* tiers in `packages/core/src/detectors.ts`
(`deriveImpactBand` sets the band whenever a wallClock estimate is
available); the constant in the last column is only a floor-case fallback.
Their *firing* gate lives in each entry's
`thresholds` object: it decides whether the rule reports anything, so it
stays documented here in full.

| Rule | Fires when | Fallback |
|---|---|---|
| Task skew | `taskDurationP95 / taskDurationP50 > 3×` (`taskDurationP50` and the other P50 fields are the textbook median: the mean of the two middle values on an even count; P95 stays nearest-rank) (`taskDurationMax / P50` for stages under `minTasksForP95` = 20 tasks), **and** the occupancy-clipped tail recovery (`tailRecoveryMs`: `finalizeStage`'s task-level replay of the stage with every task over 4× P50 capped at P50) is ≥ `floorPctWarn` = 0.5% of app runtime. The clip floors the claim at the longest task the fix leaves, not the current one, and at the core work the fix leaves over every core (see impact-estimation.md's occupancy section); `straggler`'s floors use the same clip, **and** the tail is data (`tailAttribution`: run time proportional to the slow tasks' input plus shuffle-read bytes or records accounts for at least `dataShareMin` = 0.5 of their extra time) or `unattributed` (the median task read nothing, so there is no data volume to compare, and what data, GC, fetch wait and host do not explain is the largest share, so only duration is known) | `warning` |
| Shuffle read | `shuffleReadBytes > minBytes` = 50 MiB, on a stage that isn't shorter than `stageFloorPct` = 0.5% of the run (a zero-length stage or an unknown run duration passes; the claim is clipped to the stage, so a shorter one would grade `info`, the shuffle itself still there) | `info` |
| Partition sizing: skew | `shuffleReadMax > 5×` `shuffleReadP50` **and** `shuffleReadMax > 256 MiB` | `warning` |
| Partition sizing: low parallelism | `shuffleReadBytes ≥ 1 GiB` **and** `taskCount ≤ 7` | `warning` |
| Partition sizing: oversized partition | `shuffleReadMax ≥ 5 GiB` | `critical` |
| GC | `executorRunTime ≥ minRunTimeMs` = 10 s **and** `gcPct > 10%` | `warning` |
| GC (low / cost) | `executorRunTime ≥ 10 s` **and** `gcPct < lowInfoPct100` = 5% (checked only when the GC row above did not fire **and** the log has no measured executor heap peak) **and** the stage lasts ≥ `lowInfoFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, such as one with no completion time). Gets no wall-clock estimate (an over-provisioning signal), so this band always stands. The floor drops low-GC notes from stages that barely ran: low GC is still true on those stages, but a memory-sizing note from a stage that barely ran adds nothing | `info` |
| Spill | any non-zero `memoryBytesSpilled`, on a stage that isn't shorter than `stageFloorPct` = 0.5% of the run (as for shuffle read: a shorter stage would grade `info`). The magnitude sub-table below classifies *how much*, but does not gate firing | `warning` |
| Cold start | `firstExecutorAddedAt − firstStageSubmittedAt > gapSeconds` = 30 s (no finding without executor-added events): the time a runnable stage waited for its first executor. An executor added before the first stage and still alive at submission means no wait and no finding; one removed at or before submission is ignored, so the gap runs to the next executor added after it. | `warning` |
| Slow host: mean-duration ratio | stage has ≥ `minHosts` = 3 hosts (or executors) and ≥ `minTasks` = 15 tasks, and lasts ≥ `stageFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, which gets no estimate and keeps its fallback band; every slow-host finding on a shorter stage would grade `info`, the imbalance itself still true; this gate covers every slowHost row); then per host: mean task duration / overall median ≥ `ratioWarn` = 2.0× **and** host task-share ≥ `minShare` = 20% **and** host mean ≥ `floorMs` = 1000 ms (absolute-magnitude floor, rules out sub-second noise) | `warning` |
| Slow host: duration-share | same stage gate as the row above; then per host: ≥ `shareWarn` = 75% of the stage's total task-duration **and** ≥ `taskShareWarn` = 50% of its task count | `warning` |
| Stage slowness: absolute fallback, suppressed when `slowHost` already fired | stage wall-clock duration ≥ `infoMin` = 15 min. The band then comes from the partitioning-headroom estimate (see impact-estimation.md), not the duration | `info` |
| Straggler / speculative-execution | `taskCount ≥ minTasks` = 10, **and** the stage lasts ≥ `floorPctWarn` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length, such as one with no completion time; a shorter stage's tail can't cost more than its own duration, so every finding there would grade `info`, the slow tail itself still true), **and** either any speculative task ran, **or** straggler share > `shareWarn` = 5%, **or** straggler share > `shareWarnAtFloor` = 2.5% with the occupancy-clipped tail recovery (`tailRecoveryMs`, as for skew) already ≥ `floorPctWarn` (0.5% of app runtime). Skew's `ratioWarn` = 3 and the 0.5% floor are the values the task-level tail replay was tuned against. `warnPct`/`critPct` (10%/20% speculative share) and `floorPctWarn`/`floorPctCrit` (0.5%/2% of app runtime) do not set the band; they rank the straggler-vs-speculative tiers that pick which *metric* the finding reports. The data cut and skew's gate (`ratioWarn`, `minTasksForP95`, `dataShareMin`, `floorPctWarn`) are not this detector's thresholds: it reads skew's, as resolved for the run (`DetectorCtx.skewThresholds`), so a tail that data-driven is skew's unless skew's gate does not admit it, and tuning `skew` alone never drops a tail from both. A tail skew's gate admits that data does not explain is reported here without the share test, on any stage size | `info` |
| Speculation waste | `speculationWastedAttempts ≥ minWasted` = 5 **and** `speculationWasteMs ≥ minWasteMs` = 60 s | `warning` |
| Retry waste | `wastedAttempts ≥ minWasted` = 3 **and** `retryWasteMs ≥ minWasteMs` = 30 s (attempts superseded by a later retry of the same task) | `warning` |
| Tiny tasks | `taskCount ≥ minTasks` = 100 **and** `taskDurationP50 ≤ maxP50` = 500 ms **and** `taskDurationP95 ≤ maxP95` = 1000 ms **and** the stage lasts ≥ `stageFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length; coalescing can't save more than the stage's own duration, so every finding on a shorter stage would grade `info`, the tasks still tiny). Checked against each stage's measured per-task overhead (task wall time minus executor run time, the estimate's own input): a stage with 100+ tasks outside the P50/P95 gate would not save 0.5% of its run by coalescing, while one inside it can, and grades above `info` | `info` |
| Duplicate plan subtree | a subtree of ≥ `minSubtreeSize` = 3 nodes whose shape fingerprint repeats ≥ `minOccurrences` = 2× in the plan, unless its linked stages together lasted less than `stageFloorPct` = 0.5% of the run (a repeat with no linked stage time, or an unknown run duration, is kept; the claim counts at most each stage's own task-active time, so such a repeat would grade `info`, the repeat still in the plan). `occurrencesIdentical` records whether the repeats also agree node-for-node on normalized detail, ignoring AQE query-stage numbers; when they don't (same shape over another table, filter or projection) the finding is `info` with confidence `low` and no time claim. `stageShares` gives, per stage, the repeated operators' share of the stage's operators (WholeStageCodegen wrappers and Exchange write halves not counted); with no attributed stage the finding is `info` | `warning` |
| Small files read/write | per read/write side: file count > `minFiles` = 100 **and** average file size < `maxAvgFileSizeMB` = 3 MiB | `warning` |
| Nested loop join | a `BroadcastNestedLoopJoin` or `CartesianProduct` whose executor-side `number of output rows` ≥ `minOutputRows` = 1,000,000; a `BroadcastNestedLoopJoin` also needs that output ≥ `minExpansion` = 10 × the larger of its two inputs' rows (found by walking row-preserving operators down to the nearest `number of output rows`; an input with none, or one behind an operator that can change the row count, means no finding). A `CartesianProduct` re-reads its inputs once per partition of the other side, so its input counts are not compared and the evidence carries `leftRows` and `rightRows` as null. The band comes from the wall-clock estimate over the `taskActiveMs` of the stages that run the join, with an `info` fallback | `info` |
| Python UDF | a SQL execution whose `BatchEvalPython` nodes (never `ArrowEvalPython`) report `data sent to Python workers` ≥ `minBytesSent` = 64 MiB **and** whose stages together ran ≥ `minStageMs` = 30 s. The floors are conservative guesses: no corpus or private log runs a Python UDF, so they are not tuned against real workloads. A node with no `data sent to Python workers` value is skipped | `info` |
| Broadcast sizing: missed | a 2-child `SortMergeJoin` whose smaller side is < 10 MiB (unconditional), or < 100 MiB with the larger side > 10 GiB, or < 1 GiB with larger > 300 GiB, or < 5 GiB with larger > 1 TiB (`broadcastTiers` × `comparisonTiers`) | `info` |
| Broadcast sizing: oversized | a `BroadcastExchange` node whose `data size` metric > `overBroadcastBytes` = 1 GiB | `warning` |

#### Spill magnitude tiers

The spill row's band is a fixed `warning` fallback, but `computeSpillMagnitude`
(`packages/core/src/detectors.ts`) runs on every spill finding and sets its
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
| Stage shape: PRatio | `taskCount / totalCores < 0.5` (info, under-parallelized), on a stage lasting ≥ `lowParallelismFloorPct` = 0.5% of the run (passes when the run's duration is unknown or the stage has zero length): parallelizing can't save more than the stage's duration, so a shorter stage would fire below the floor | none |
| Stage shape: OIRatio | `outputBytes / inputBytes > 10×` (info, data explosion) | none |
| Stage shape: TaskStageSkew | `taskDurationMax / stageDuration > stageShareMin` = 0.5 **and** `taskDurationMax / taskDurationP50 > skewWarn` = 3× (info), on a multi-task stage lasting ≥ `taskStageSkewFloorPct` = 0.5% of the run. A task runs inside its stage, so the share is at most 1; the median gate is needed because on a single wave of even tasks the longest one spans the whole stage too | none |
| Failed tasks | failure rate > 5% (min 10 tasks) | > 20% |
| Stage failed outright | none | any `stageFailureReason` present |
| Slow host: multi-dimensional | max/median ratio across taskTime/inputBytes/shuffleBytes/storageMemory ≥ 1.33× (info); each dimension's sample must also clear an absolute floor (1000 ms for taskTime, 64 MiB for the byte dimensions). A stage lasting under `stageFloorPct` = 0.5% of the run is skipped (see the mean-duration row): a byte dimension there has no time estimate and would otherwise keep its ratio tier (a shorter stage's byte dimension would otherwise keep a warning or critical tier). The taskTime dimension falls back to `info` and takes its band from its wall-clock estimate; the byte dimensions get no time estimate and keep the ratio tier | ≥ `ratioTiers[1]` = 1.78× warning, ≥ `ratioTiers[3]` = 10× critical (`ratioTiers[2]` = 3.16 is not read) |
| Utilization | busy core time / allocated core time < 60% (info) | none |
| Autoscaling churn: short-lived executors | > 30% of executors alive under 2 min (min 5 executors) | > 60% |
| Job failure rate | ≥ 30% (≥ 10% info) | ≥ 50% |
| Idle cores | idle share of allocated core time > 50% (warning) | none |
| Memory band | highest executor peak heap / allocated < 70% over-provisioned (info); no near-capacity band, since heap used counts uncollected garbage | none |
| Caching opportunity | same input relation (or join/union subtree) scanned by ≥ `minExecutions` = 2 SQL executions in one run | none (single tier, info) |
| Cache utilization: partial caching | `numCachedPartitions / numPartitions < 0.90` (info) | `< 0.50` (warning) |
| Cache utilization: disk spillover | `diskSize / (memorySize + diskSize) > 0.15` (info), `MEMORY_AND_DISK*` only | `> 0.40` (warning) |
| Cache utilization: storage unobserved | persisted RDDs, but no `SparkListenerBlockUpdated` for any `rdd_*` block and every RDD Info figure 0 (`spark.eventLog.logBlockUpdates.enabled` off on Spark 2.3+): a missing-evidence caveat, not a threshold | none (single tier, info) |
| Core locality | non-local task ratio ≥ `warnRatio` = 15% (min `minTasks` = 50 tasks) | ≥ `critRatio` = 35% |
| Config: memory overhead | `spark.executor.memoryOverhead` below max(minimum, factor × executor memory) (info). The minimum is `spark.executor.minMemoryOverhead` on Spark 4+, else `floorMB` = 384 MiB; the factor is `spark.executor.memoryOverheadFactor` on Spark 3.3+, else `floorPct` = 10%. An unrecorded Spark version reads both settings | none |

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
