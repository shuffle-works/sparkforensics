### `SLOW`: Stage slowness {#slow}

A stage ran for 15 minutes or more and no slow host was flagged on it. It
can appear alongside other findings on the same stage. On a stage that reads a
shuffle, often a partition-count problem: raise parallelism via
`spark.sql.shuffle.partitions` or `spark.default.parallelism`, or check for a
large per-task data volume driving heavy shuffle and spill. On a stage that
reads input files and no shuffle, check input file sizes and lower
`spark.sql.files.maxPartitionBytes`. `evidence.reads` says which case
applied (`shuffle`, `input` or `other`).
