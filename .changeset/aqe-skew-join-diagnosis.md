---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Skew, straggler and partition-skew findings on a stage that runs a sort-merge or shuffled-hash join now say why AQE skew-join handling did or did not act, instead of "AQE skew-join handling is already on, so salt the key". The case comes from the execution's final plan and its effective Spark conf, and is published as `evidence.aqeSkew`:

- `split`: AQE split the skewed partition, so the remaining imbalance is not join skew.
- `belowThreshold`: the largest partition is under `spark.sql.adaptive.skewJoin.skewedPartitionThresholdInBytes` or not far enough over the median for `spark.sql.adaptive.skewJoin.skewedPartitionFactor`; the remediation lowers them for the query.
- `planShape`: an aggregate, window or other operator sits between the join and its shuffle.
- `userRepartition`: the shuffle under the join is a `repartition` or `rebalance` in the job.
- `joinType`: the join type does not let AQE split the skewed side (full outer joins, or the right side of a left outer, left semi and left anti joins, or the left side of a right outer join).
- `extraShuffle`: splitting would add a shuffle for the aggregate, window or join above; the remediation sets `spark.sql.adaptive.forceOptimizeSkewedJoin`.
- `notSplit`: the thresholds and plan allow it and the log does not say why it did not happen.

A stage that no join in its execution's plan ran in is now `origin: other` when the plan ties its joins to stages. `SortMergeJoin(skew=true)` and `ShuffledHashJoin(skew=true)` nodes now count as joins.
