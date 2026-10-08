---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Skew, straggler and partition-skew findings on a stage that runs a sort-merge or shuffled-hash join now say why AQE skew-join handling did or did not act, instead of "AQE skew-join handling is already on, so salt the key". The case comes from the execution's final plan and its effective Spark conf, and is published as `evidence.aqeSkew`:

- `split`: AQE split the skewed partition, so the remaining imbalance is not join skew.
- `evenReads`: the stage's shuffle reads are even (the largest task read under twice the median), so the slow tail is not partition-size skew; no conf is suggested.
- `belowThreshold`: the largest partition is clearly over the median but under `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` or not far enough over the median for `spark.sql.adaptive.skewJoin.skewedPartitionFactor`; the remediation lowers them for the query.
- `planShape`: an aggregate, window or other operator sits between the join and its shuffle.
- `userRepartition`: the shuffle under the join is a `repartition` or `rebalance` in the job.
- `joinType`: the join type does not let AQE split the skewed side (full outer joins, or the right side of a left outer, left semi and left anti joins, or the left side of a right outer join).
- `extraShuffle`: splitting would add a shuffle for the aggregate, window or join above; the remediation sets `spark.sql.adaptive.forceOptimizeSkewedJoin`, or is a `code` entry before Spark 3.3, which has no such property.
- `notSplit`: the thresholds and plan allow it and the log does not say why it did not happen.

`SortMergeJoin(skew=true)` and `ShuffledHashJoin(skew=true)` nodes now count as joins.

In the dashboard's Findings table, a grouped row no longer shows a one-line fix when its findings have different ones, such as skew findings with different AQE cases.
