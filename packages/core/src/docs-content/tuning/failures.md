# Task Failures

<span class="tag">FAIL</span>

## What it is

A task failure is any task end whose `Reason` field is something other than success. Spark's
event log serializes this as the formatted class name of whichever `TaskEndReason` instance was
assigned to that task attempt[^1], and the canonical set of reasons is `Success`, `FetchFailed`,
`ExceptionFailure`, `TaskResultLost`, `TaskKilled`, `TaskCommitDenied`, `ExecutorLostFailure`,
`Resubmitted`, and `UnknownReason`[^1]. Each carries its own extra detail: a `FetchFailed` records
a reduce ID and message; an `ExceptionFailure` carries the exception's class name, description,
and stack trace, plus accumulator updates (falling back to reading them out of the task's metrics
object for logs written by Spark 1.x); a `TaskKilled` records a kill reason; a `TaskCommitDenied`
records the job ID, partition ID, and attempt number; an `ExecutorLostFailure` records whether the
loss was caused by the application, the executor ID, and a loss reason; `UnknownReason` carries no
extra fields[^1].

## How it's detected

| failed tasks (share) | Level |
|---|---|
| > 5% | Warning |
| > 20% | Critical |

The task-metrics object attached to a `SparkListenerTaskEnd` event is optional in the schema, so
it isn't guaranteed to be present for every failure. It tends to be populated for reasons where the
attempt actually ran far enough to produce metrics (an `ExceptionFailure` or `TaskKilled`, for
instance) but can be absent for a `Resubmitted` attempt that never completed on its executor at
all[^1]. Detection has to key off the `Reason` field itself rather than assume metrics will always
be there to inspect.

## Why it matters

Some reasons point at something worse than a one-off hiccup. An
`ExecutorLostFailure` can be the knock-on effect of a container or pod killed for exceeding its
memory grant: enabling off-heap memory without also raising `spark.executor.memoryOverhead` (or
setting `spark.executor.pyspark.memory` explicitly) lets real usage exceed what YARN or Kubernetes
allocated, and the executor is killed with a generic container-memory error rather than a
Spark-level exception[^2]. Losing an executor mid-shuffle can also cascade into failures elsewhere:
if dynamic allocation removes an executor before a shuffle it wrote data for has completed, that
shuffle output is gone, and downstream tasks reading it fail and force an unnecessary recompute[^3].

## How to fix it

- Read the `Reason` field before treating all failures the same: an `ExceptionFailure` points at
  application code, and an `ExecutorLostFailure` usually points at memory sizing or infrastructure.
- For memory-driven `ExecutorLostFailure`s, size `spark.executor.memoryOverhead` (which defaults
  to `max(384 MB, 10% of executor memory)`) to actually cover off-heap and PySpark memory, since
  neither is folded into that default budget automatically[^2].
- For failures caused by dynamic allocation reclaiming an executor mid-shuffle, enable the external
  [shuffle service](#shuffle) or `spark.dynamicAllocation.shuffleTracking.enabled` so shuffle output can outlive
  the executor that wrote it, instead of being lost and recomputed[^3].

Config-only levers for memory-driven `ExecutorLostFailure`s and mid-shuffle executor loss:

```properties
# Cover off-heap + PySpark memory the default overhead budget does NOT include.
# Default is max(384m, 10% of executor memory); 2g is an example, size to real off-heap/PySpark use.
spark.executor.memoryOverhead=2g

# Keep shuffle output alive when dynamic allocation reclaims an executor mid-shuffle
spark.dynamicAllocation.shuffleTracking.enabled=true
```

## Failed stage

<span class="tag">SFAIL</span>

A single task failing and a whole stage failing are handled by different parts of the
scheduler. Task retries sit in the TaskScheduler; the stage-level verdict belongs to the
[DAGScheduler](#spark-architecture), which decides whether the job as a whole lives or dies. When a stage fails,
it is not abandoned on the spot: the DAGScheduler resubmits it as a fresh attempt, and the
job only fails once the stage cannot make progress after repeated attempts[^5]. So the
difference between "retried and succeeds" and "aborts the job" is whether a later
attempt finishes before the attempt budget runs out.

<img class="light-only" src="../diagrams/retry-escalation-ladder.svg" alt="The layered budgets a repeated failure climbs through, from task retries to stage resubmission to the executor and application ceilings that abort the job.">
<img class="dark-only" src="../diagrams/retry-escalation-ladder.dark.svg" alt="The layered budgets a repeated failure climbs through, from task retries to stage resubmission to the executor and application ceilings that abort the job.">

That budget is `spark.stage.maxConsecutiveAttempts`, default 4: the number of consecutive
stage attempts allowed before the stage is aborted[^4]. Fail, resubmit, and complete within
those attempts and the job stays alive; keep failing until the limit is spent and the job
aborts.

A `FetchFailed` is the classic trigger. It counts against that stage attempt limit, which is
why `spark.stage.ignoreDecommissionFetchFailure` (default `true` since 3.4.0) exists: it keeps
a fetch failure caused by an executor being decommissioned from counting toward
`spark.stage.maxConsecutiveAttempts`, which by implication means ordinary fetch failures
otherwise do count toward the abort budget[^4].

Executor exclusion is the other stage-level lever. The `spark.excludeOnFailure.*` family is
off by default (`spark.excludeOnFailure.enabled` is `false`) and tracks how many tasks must
fail on one executor within a stage before that executor is excluded for the stage; it can
also kill executors excluded on a fetch failure[^4]. If exclusion leaves a TaskSet with no
schedulable executor left, `spark.scheduler.excludeOnFailure.unschedulableTaskSetTimeout`
(default 120s) caps how long Spark waits to acquire a new executor before aborting that
TaskSet[^4].

## Confidence

The failed-task-share thresholds and the stage-failure behaviour both map to
documented Spark scheduler mechanics; no branch here is experimental.

## Limitations / false-positive risk

A high failed-task share is a blunt signal. It can be dominated by one systemic cause, such
as a single lost executor whose tasks all fail at once, rather than many independent
failures pointing at a code or data problem. Transient failures that a later attempt retries
and succeeds are also not always harmful: task retries reset their count on success, so a
job can carry a nonzero failure share and still finish correctly. Read the `Reason`
distribution before treating the share as a defect.


## Related

- **Executor sizing:** [Cluster Tuning](#cluster-config)
- **Memory overhead & off-heap:** [Memory Management](#memory-model)

[^1]: [JsonProtocol.scala](https://raw.githubusercontent.com/apache/spark/v3.5.0/core/src/main/scala/org/apache/spark/util/JsonProtocol.scala)
[^2]: [Dive Into Spark Memory](https://luminousmen.com/post/dive-into-spark-memory)
[^3]: [Job Scheduling (Apache Spark Documentation)](https://spark.apache.org/docs/latest/job-scheduling.html)
[^4]: [Spark Configuration (Apache Spark Documentation)](https://spark.apache.org/docs/latest/configuration.html)
[^5]: [Anatomy of a Spark Application](https://luminousmen.com/post/spark-anatomy-of-spark-application)
