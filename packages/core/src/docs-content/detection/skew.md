### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. For join-driven skew, enable AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`); otherwise salt the key or
repartition on a better key. Flagged when P95 task time (the longest task,
on a stage with fewer than 20 tasks) exceeds 3x the median and the
recoverable tail is at least 0.5% of the run.
