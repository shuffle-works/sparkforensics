# Task Skew

<span class="tag">SKEW</span>

## What it is

Task skew happens when a shuffle produces one or a few oversized partitions instead of a
roughly even split. Spark's own skew-join optimizer defines a partition as skewed once it is
both larger than a multiple of the median partition size and larger than an absolute byte
threshold[^1]: in the shipped implementation, more than 5× the median size and more than
256 MB by default[^2]. Whatever task draws that oversized partition ends up processing far
more data than everyone else in the same stage.

## How it's detected

| Signal | Fires when |
|---|---|
| P95 / median task duration (stage has ≥ 20 tasks) | > 3× |
| Max / median task duration (stage has < 20 tasks) | > 3× |

A 3× ratio marks a stage as skewed. Beyond that ratio, the estimated recoverable time (the
P95-minus-median, or max-minus-median, delta) needs to clear 0.5% of the app's total
runtime before it registers, a floor that filters out a 3× ratio sitting on a few
milliseconds. Severity then tracks that same recoverable-time estimate as a share of the
app's total runtime: ≥2% is critical, ≥0.5% is warning, anything smaller is info. A 3×
ratio on a stage that barely dents an eight-hour run typically surfaces as info; the same
ratio on a stage that dominates a short run reads as critical.

## Why it matters

An oversized partition becomes a [straggler task](#bottleneck-straggler): it's processed inside a single task, so the
stage can't finish until that task does, no matter how long it takes. Spark's own skew
handling treats splitting the partition as a deliberate trade-off: reading the other join
side's matching partition once per split costs extra I/O, but the design behind the feature
argues that cost is worth paying once the skew is severe enough to be producing a straggler
in the first place[^1].

## How to fix it

- Enable Adaptive Query Execution's skew-join handling (`spark.sql.adaptive.skewJoin.enabled`,
  default `true` once `spark.sql.adaptive.enabled` is also on[^2]). It divides any partition that
  crosses the skew thresholds into several smaller sub-partitions, joins each one against the
  matching data on the other side, and unions the results back together[^1].
- Before AQE existed, the only options were manual, and each carries real limitations, which
  is exactly the gap AQE's skew handling was built to close[^1]: salt the join key, over-size
  `spark.sql.shuffle.partitions`, or push the [broadcast-join threshold](#bottleneck-broadcast-sizing) up so the join goes
  broadcast instead of sort-merge.
- To salt by hand: add a random suffix to the join key on both sides, exploding the smaller
  side into one row per salt value so every salted variant of the key still finds a match, then
  join on the combined (key, salt) pair[^3].
- On Databricks, a `SKEW` hint can name the skewed relation and column (and, optionally, the
  exact skewed values) directly, letting the planner build a skew-aware plan without hand-rolled
  salting[^4].

> **PySpark:** salting is plain DataFrame code, no special API, just
> `withColumn("salt", (fn.rand() * n).cast("int"))` on the larger side and an `explode` over
> the salt range on the smaller side before joining on the combined key.

The AQE toggle, plus the manual salting fallback as runnable code:

```python
from pyspark.sql import functions as fn

# AQE skew-join handling — active once AQE itself is enabled
spark.conf.set("spark.sql.adaptive.enabled", "true")
spark.conf.set("spark.sql.adaptive.skewJoin.enabled", "true")

# Manual salting fallback (pre-AQE): spread the skewed key across N salted variants.
# N is an example — size it to how badly the key is skewed.
N = 16
salted_big = big.withColumn("salt", (fn.rand() * N).cast("int"))
salted_small = small.withColumn(
    "salt", fn.explode(fn.array([fn.lit(i) for i in range(N)]))
)
joined = salted_big.join(salted_small, ["key", "salt"]).drop("salt")
```

## Confidence

Validated. These thresholds mirror Spark's own skew-join optimizer, which
defines a skewed partition by the same style of ratio-plus-absolute test applied here
to task durations[^1][^2].

The `Stage shape` subsection below is a separate, experimental branch: its heuristics are
informational stage-shape observations, not a validated finding, so it carries an
`EXPERIMENTAL` badge and should not be read as a diagnosis on its own.

## Limitations / false-positive risk

A task-duration ratio is a proxy for skew, not proof of it. A single long task can just as
easily be a garbage-collection pause or a genuinely slow host, and either one inflates the
max/median ratio without any partition being oversized. Small stages make the number
jumpy: with only a handful of tasks, one slow outlier moves the median enough to trip the
threshold on noise alone. Treat the signal as a prompt to look at the stage, not a verdict.

## Stage shape {#bottleneck-stage-shape}

<span class="tag">SHAPE</span> <span class="tag">EXPERIMENTAL</span>

These are experimental, information-only heuristics about a stage's overall shape, not a
graded finding. They read the relationship between a stage's task count and the cluster's
resources, and none of them alone means something is wrong.

A stage's task count equals the number of partitions in its output, and each task runs as a
single thread against one partition, so that count is what caps how much of the cluster the
stage can actually use. Three shapes are worth noticing:

- **Low parallelism** (task count far below total executor cores). When a stage has fewer
  tasks than there are core slots to run them in, cores sit idle and the stage cannot put
  the cluster's CPU to work; the same shape also concentrates more memory pressure into
  each task's aggregation[^5]. Spark's guidance is to keep parallelism high enough that the
  cluster does not stay under-used, roughly 2 to 3 tasks per CPU core in general[^6].
- **Data explosion** (task count far above cores, partitions tiny). Push the count too high
  and partitions shrink until per-task overhead floods the stage, so the scheduling cost
  starts to dominate the useful work[^7].
- **Task and stage skew** (uneven task count or duration). A lopsided split shows up as a
  few tasks carrying the stage while the rest finish early, which is the same imbalance the
  graded `skew` finding above tracks by duration ratio.

## Related

- **Why it happens:** [Partitioning](#partitioning), [Join Optimization](#joins)
- **How Spark fixes it automatically:** [Adaptive Query Execution](#aqe)

[^1]: [SPARK-29544: Optimize Skewed Join at Runtime](https://issues.apache.org/jira/browse/SPARK-29544)
[^2]: [Configuration (Spark)](https://spark.apache.org/docs/latest/configuration.html)
[^3]: [Spark Tips: Partition Tuning](https://luminousmen.com/post/spark-tips-partition-tuning)
[^4]: [Skew Join Hint](https://docs.databricks.com/aws/en/archive/legacy/skew-join)
[^5]: [How to Tune Your Apache Spark Jobs (Part 2)](https://blog.cloudera.com/how-to-tune-your-apache-spark-jobs-part-2/)
[^6]: [Tuning - Spark](https://spark.apache.org/docs/latest/tuning.html)
[^7]: [Spark Partitions](https://luminousmen.com/post/spark-partitions)
