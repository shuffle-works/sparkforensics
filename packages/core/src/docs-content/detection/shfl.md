### `SHFL`: Shuffle I/O {#shfl}

Tasks move a large amount of intermediate data between stages. Raise
`spark.sql.shuffle.partitions`, or add a broadcast join. Only flagged on
stages that take at least 0.5% of the run.
