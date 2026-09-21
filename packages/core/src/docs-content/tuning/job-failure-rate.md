# Job Failure Rate

<span class="tag">FAIL-RATE</span>

## What it is

Not every task retry threatens the job. `spark.task.maxFailures` (default `4`) counts
"continuous failures of any particular task before giving up on the job. The total number of
failures spread across different tasks will not cause the job to fail; a particular task has to
fail this number of attempts continuously. If any attempt succeeds, the failure count for the
task will be reset"[^1]. A task that fails once and then succeeds on retry resets its counter and
never counts toward job abandonment: that's a transient retry, and by itself it's harmless.
Whole-job abandonment is a different, layered escalation above that: it only happens once an
unbroken run of failures on the same task reaches the configured limit (3 retries allowed by
default, since allowed retries = value − 1), or once higher-level retry budgets above the task
level are themselves exhausted.

## How it's detected

The layers above task-level retries are what turn isolated failures into a failed job. At the
stage level, `spark.stage.maxConsecutiveAttempts` (default `4`) bounds "the number of consecutive
stage attempts allowed before a stage is aborted"[^1]. By default,
`spark.stage.ignoreDecommissionFetchFailure` (`true`, since 3.4.0) excludes fetch failures caused
by graceful executor decommission from counting toward that limit, so a decommission-triggered
`FetchFailed` doesn't push a stage toward abortion the way a genuine repeated fetch failure
would[^1]. On YARN and Kubernetes there's a further application-level ceiling:
`spark.executor.maxNumFailures` (default `numExecutors * 2`, minimum 3, since 3.5.0) is "the
maximum number of executor failures before failing the application," while
`spark.executor.failuresValidityInterval` (since 3.5.0) lets failures spaced far enough apart be
"considered independent and not accumulate towards the attempt count"[^1]. The TaskScheduler owns
retries at the task level, but it is "the DAGScheduler that ultimately declares the job to have
failed"[^2] once those retry budgets are exhausted, and because "a Spark job corresponds to one
action" with a fixed DAG once that action is called[^3], an aborted stage cascades directly into
failure of the job built on it.

<img class="light-only" src="../diagrams/retry-escalation-ladder.svg" alt="How a failure escalates from a task retry up through stage resubmission, the executor failure ceiling, and a failed application attempt before the job is aborted.">
<img class="dark-only" src="../diagrams/retry-escalation-ladder.dark.svg" alt="How a failure escalates from a task retry up through stage resubmission, the executor failure ceiling, and a failed application attempt before the job is aborted.">

## Why it matters

A rising failure rate that traces back to exhausted retry budgets, rather than to a single
one-off task failure, points at a systemic problem (an unstable executor, a genuinely broken
fetch path, or a resource ceiling being hit repeatedly) since none of these budgets trip on a
single transient hiccup. Job-level failure is also distinct from application-attempt failure: on
YARN, "each application may have multiple attempts," and the history server displays failed
attempts alongside "any ongoing incomplete attempt or the final successful attempt"[^4]: a
separate, higher layer of retry (driver/application restart) above the in-job task and stage
retries covered here.

## How to fix it

- Check which budget was exhausted before treating a job failure as a single root cause: a
  single task failing `spark.task.maxFailures` times consecutively, a stage being resubmitted
  until `spark.stage.maxConsecutiveAttempts` is reached and aborted, or (on YARN/Kubernetes)
  cumulative distinct executor failures exceeding `spark.executor.maxNumFailures`[^1] each point
  at a different underlying problem.
- If failures are decommission-triggered `FetchFailed`s during a normal scale-down, confirm
  `spark.stage.ignoreDecommissionFetchFailure` is enabled (default `true` since 3.4.0) so they
  aren't inflating the stage-abort count[^1].
- On YARN/Kubernetes, if unrelated executor failures spread far apart in time are tripping
  `spark.executor.maxNumFailures`, `spark.executor.failuresValidityInterval` (since 3.5.0) can
  let sufficiently-spaced failures stop accumulating toward the same count[^1].
- See also [retry waste](#bottleneck-retry-waste): the same executor-loss and `FetchFailed`
  causes that eventually exhaust these budgets and fail a job are, below that threshold, also
  the source of wasted executor time on jobs that ultimately succeed.

> **PySpark:** these are session-level configs, settable without a `spark-submit` flag:
> `spark.conf.set("spark.task.maxFailures", "4")`, and the stage/executor-level equivalents the
> same way.

The retry-budget ladder: defaults shown; raise a budget only once you know which layer is tripping:

```properties
# Task level: consecutive failures of one task before the job is abandoned (default 4 => 3 retries)
spark.task.maxFailures=4

# Stage level: consecutive stage attempts before the stage is aborted (default 4)
spark.stage.maxConsecutiveAttempts=4

# Don't count graceful-decommission fetch failures toward the stage-abort limit (default true since Spark 3.4)
spark.stage.ignoreDecommissionFetchFailure=true
```


## Limitations / false-positive risk

A nonzero job-failure rate can be dominated by a single repeatedly-failing job rather than a
systemic issue, so the rate alone doesn't tell you whether the problem is broad or isolated.
Retried jobs that eventually succeed still count toward attempts, which can inflate the rate
above what the eventual outcomes justify.


## Related

- **Retry budgets & executor stability:** [Cluster Tuning](#cluster-config)
- **Avoiding the failures upstream:** [Anti-Patterns](#anti-patterns)

[^1]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^2]: [Spark: Anatomy of Spark Application](https://luminousmen.com/post/spark-anatomy-of-spark-application)
[^3]: *High Performance Spark, 2nd Edition*, Karau, Polak & Warren, ch. 2
[^4]: [Monitoring and Instrumentation](https://spark.apache.org/docs/latest/monitoring.html#spark-history-server)
