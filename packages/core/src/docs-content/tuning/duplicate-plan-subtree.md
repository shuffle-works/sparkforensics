# Duplicate Plan Subtree

<span class="tag">DUPPLAN</span>

## What it is

The physical plan is the form Spark actually runs: after optimizing the logical plan, the engine produces a plan that "specifies how the logical plan will execute on the cluster," compiling the query into a series of RDDs and transformations[^1]. A duplicated subtree is the same source read, together with the operators stacked above it, appearing in more than one branch of that plan. When the same logic sits in two different branches of a pipeline, you are "basically signing up to recompute everything from scratch multiple times," because every action on an uncached DataFrame starts back at the source and rebuilds all the intermediate steps[^2].

## How it's detected

Exchanges are the giveaway. A [shuffle](#shuffle) or broadcast is an exchange, and these are the points where Spark's pipelining stops: "Spark operators are often pipelined and executed in parallel processes. However, a shuffle or broadcast exchange breaks this pipeline. We call them materialization points and use the term 'query stages' to denote subsections bounded by these materialization points"[^3]. The signal is the same source-plus-operators subtree feeding more than one branch across those materialization boundaries, which is the shape that gets recomputed unless something intervenes.

<img class="light-only" src="../diagrams/duplicate-plan-subtree.svg" alt="Before and after: the same scan and operators feed two branches and run twice, then a single shared node from exchange reuse or a cache feeds both consumers.">
<img class="dark-only" src="../diagrams/duplicate-plan-subtree.dark.svg" alt="Before and after: the same scan and operators feed two branches and run twice, then a single shared node from exchange reuse or a cache feeds both consumers.">

| Signal | What it points to |
|---|---|
| Identical scan + operators in two or more branches | Same subtree recomputed per branch |
| A materialization point (shuffle/broadcast) below the repeat | The pipeline breaks and the branch restarts from source |

## Why it matters

Left alone, a repeated subtree is repeated work. Each branch re-reads the source and re-runs everything above it, so a subtree that shows up twice is roughly paid for twice[^2]. That cost lands on exactly the expensive parts of a plan (scans and shuffles) rather than on cheap row-level operators.

## How to fix it

Two mechanisms let a plan reuse an identical subtree instead of rebuilding it.

- Exchange reuse leans on the fact that a shuffle already writes its output to disk. Spark "always executes shuffles by first having the 'source' tasks ... write shuffle files to their local disks," so "running a new job over data that's already been shuffled does not rerun the 'source' side of the shuffle. Because the shuffle files were already written to disk earlier, Spark knows that it can use them to run the later stages of the job, and it need not redo the earlier ones. In the Spark UI and logs, you will see the pre-shuffle stages marked as 'skipped'"[^1]. When the same materialized exchange feeds two consumers, the second reads those existing shuffle files instead of recomputing the subtree beneath it.
- `cache()` / `persist()` truncate recomputation by materializing the result and keying future lookups on it. Persisting "means materializing an RDD (usually by storing it in memory on the executors) for reuse during the current job"[^2], and in the Structured API the lookup is plan-keyed: "caching is done based on the physical plan. This means that we effectively store the physical plan as our key ... and perform a lookup prior to the execution of a Structured job"[^1]. On a hit, Spark returns the stored data rather than rebuilding intermediate steps from the source[^2].

> **PySpark:** if the repeated subtree is a DataFrame you reuse across branches, `df.cache()` (or `df.persist()`) before the branches split lets both read the materialized result instead of recomputing it.

## Confidence

Medium. Inferring a duplicated subtree from the static plan is a medium-confidence signal that requires runtime validation: whether a repeated subtree actually turns into avoided work depends on runtime facts the plan never shows, such as cache hits, retained shuffle files, and eviction[^2].

## Limitations / false-positive risk

Two subtrees that look identical in the printed plan are not always the same recomputed work. The cache "is tied to the analyzed logical plan, not the final optimized one," so semantically identical queries with different analyzed plans miss the cache and recompute even though "the optimizer will eventually produce the same physical plan"[^2]. [Caching](#caching) is also lazy and often partial: it happens "only as they are accessed," "the only blocks that get cached are the ones Spark was forced to touch," and Spark gives "no built-in visibility into how much of your DataFrame is actually cached, or how much has already been evicted"[^2]. Plan-level inference can therefore over-count, flagging repetition that either never materializes or is only partly reused.


[^1]: [Spark: The Definitive Guide](https://www.oreilly.com/library/view/spark-the-definitive/9781491912201/), Chambers & Zaharia, chs. 4, 15, 19
[^2]: [Explaining the mechanics of Spark caching](https://luminousmen.com/post/explaining-the-mechanics-of-spark-caching)
[^3]: [Adaptive Query Execution: Speeding Up Spark SQL at Runtime](https://www.databricks.com/blog/2020/05/29/adaptive-query-execution-speeding-up-spark-sql-at-runtime.html)
