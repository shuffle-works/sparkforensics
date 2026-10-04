### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join. The partition-count
advice follows the effective conf (`evidence.partitions`): `raise` when the
property limits the stage, `sufficient` when the tasks already read a good
size each, `aqeCoalesced` when AQE merged the partitions (lower
`spark.sql.adaptive.advisoryPartitionSizeInBytes`), and `ownPartitioning` when
the property is already high enough (the stage's own `repartition(n)` or RDD
parallelism limits it). Only flagged on stages that take at least 0.5% of the
run.
