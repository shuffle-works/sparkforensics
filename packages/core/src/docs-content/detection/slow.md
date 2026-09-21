### `SLOW`: Stage slowness {#slow}

A stage ran long overall without a more specific cause getting flagged.
Often a partition-count problem: raise parallelism via
`spark.sql.shuffle.partitions` or `spark.default.parallelism`, or check for a
large per-task data volume driving heavy shuffle and spill.
