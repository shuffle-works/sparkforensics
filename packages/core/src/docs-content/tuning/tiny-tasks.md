# Tiny Tasks

<span class="tag">TINY</span>

## What it is

Every task pays a fixed placement and serialization cost before it does any real work. Spark
schedules around data locality rather than moving data to code: "Spark builds its scheduling
around this general principle" that shipping serialized code is cheaper than shipping data,
preferring `PROCESS_LOCAL` locality down to `ANY` and waiting a configurable timeout for a busy
CPU to free up before shipping data to a farther executor[^1]. On top of that placement cost,
every task also pays a serialization cost for its closure and, if not using Kryo, for its data:
Java's default `ObjectOutputStream`-based serialization "is flexible but often quite slow, and
leads to large serialized formats," while Kryo is "significantly faster and more compact than
Java serialization (often as much as 10x)"[^1]. None of that overhead is large per task: Spark's
own guidance leans toward more, smaller tasks rather than fewer, larger ones, unlike MapReduce:
"it's almost always better to err on the side of a larger number of tasks (and thus partitions)...
The difference stems from the fact that MapReduce has a high startup overhead for tasks, while
Spark does not"[^2]. But once partitions get small enough, that per-task overhead stops being
negligible and starts to dominate.

## How it's detected

The failure mode is partitions so small that scheduling and serialization overhead outweighs the
actual work. With Spark's default of 200 shuffle partitions applied to a dataset of only a few
megabytes, "those 200 partitions will each get like ten rows. Tasks become microscopic. Most of
your CPUs will just be sitting there doing nothing, wasting cluster hours"[^3]. The same
small-partition penalty shows up on the [shuffle-read side](#bottleneck-shuffle): production measurements found "the
average shuffle block size is only 10s of KBs, which leads to delayed shuffle data fetch," and
the shuffle reduce stages with the largest fetch delays (over 30 seconds per task) were
consistently the ones with small block sizes[^4]. A high task count paired with very short median
task duration, and/or very small shuffle block sizes on the read side, are the signals to look
for.

## Why it matters

Tiny tasks waste cluster capacity even though no single task is a straggler the way
[skewed](#bottleneck-skew) or [straggler](#bottleneck-straggler) tasks are: the cost here is
spread evenly across thousands of tasks, each individually cheap but collectively adding up in
scheduling and serialization overhead, while cores that could be doing other useful work sit
mostly idle between task launches[^3].

## How to fix it

- `coalesce()` merges existing partitions without a shuffle ("no data movement, no shuffle")
  and is typically used right before a write, e.g. `df.coalesce(100).write.parquet(...)`, to
  collapse many tiny output files into a manageable number cheaply[^3]. Because it only stacks
  partitions together rather than redistributing data, it doesn't fix an uneven underlying
  distribution (uneven input partitions stay uneven, just grouped) and pushing it too far
  (`coalesce(1)`) kills parallelism by funneling all work onto one executor while the rest sit
  idle[^3].
- `repartition()` performs a full reshuffle, giving control and rebalancing that Spark won't do
  on its own: with `df.repartition(200)`, "you're paying for predictability"[^3]. Use it when
  the partitioning itself needs to be fixed or rebalanced, not merely reduced in count, accepting
  the shuffle cost to get there.
- There's a middle option, `coalesce(N, shuffle=True)`, which "acts more like a repartition, but
  leaning toward reduction... not free (you pay for the shuffle cost) but you get better
  distribution and fewer partitions"[^3].
- Rule of thumb: reach for `coalesce()` when only the partition count needs to shrink and the
  existing distribution is already reasonably even (e.g. collapsing output files); reach for
  `repartition()` when the distribution itself is the problem.

> **PySpark:** both are one-line calls on a DataFrame: `df.coalesce(100)` for a shuffle-free
> merge, `df.repartition(200)` for a full reshuffle, or `df.coalesce(100, shuffle=True)` for the
> shuffled middle option.

The three sizing calls, side by side:

```python
# Collapse many tiny output files without a shuffle (use when distribution is already even)
df.coalesce(100).write.parquet(path)

# Full reshuffle to a target count — use when the distribution itself needs rebalancing
df = df.repartition(200)

# Middle ground: reduce partition count but still rebalance (pays a shuffle)
df = df.coalesce(100, shuffle=True)
```

## Limitations / false-positive risk

Very short tasks are not always a problem. A tiny final stage can be perfectly fine, and one
that just writes a small result set doesn't need to be resized. The scheduling-overhead penalty
only bites when tiny tasks dominate the stage, so treat a handful of short tasks as noise rather
than a finding.

## Related

- **Partition sizing:** [Partitioning](#partitioning)

[^1]: [Tuning (Spark)](https://spark.apache.org/docs/latest/tuning.html)
[^2]: [How to Tune Your Apache Spark Jobs (Part 2): Cloudera](https://blog.cloudera.com/how-to-tune-your-apache-spark-jobs-part-2/)
[^3]: [Spark Partitions](https://luminousmen.com/post/spark-partitions)
[^4]: [SPARK-30602](https://issues.apache.org/jira/browse/SPARK-30602)
