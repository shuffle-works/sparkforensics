### `TINY`: Tiny tasks {#tiny}

Many very short tasks add scheduling overhead out of proportion to the work
each one does. Repartition to fewer, larger tasks; a stage that reads a shuffle
(`evidence.reads` is `shuffle`) can also lower `spark.sql.shuffle.partitions`.
Only flagged on stages that take at least 0.5% of the run.
