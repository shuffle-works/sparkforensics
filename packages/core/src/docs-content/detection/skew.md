### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. The fix depends on what the stage reads, which the finding's
`evidence.origin` records. A stage that reads a shuffle feeding a join
(`shuffleJoin`) gets AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`), unless the run's effective conf
already has it; otherwise salt the key or repartition on a better key. A
stage that reads files with uneven sizes (`inputScan`) gets compaction of
small files or a lower `spark.sql.files.maxPartitionBytes`. Any other stage
(`other`) gets the salting advice and no conf. Flagged when P95 task time
(the longest task, on a stage with fewer than 20 tasks) exceeds 3x the median
and the recoverable tail is at least 0.5% of the run. The median is the
textbook one: on an even task count, the mean of the two middle values.
