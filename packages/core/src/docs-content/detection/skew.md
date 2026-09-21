### `SKEW`: Task skew {#skew}

A small number of tasks take much longer than their peers in the same
stage. For join-driven skew, enable AQE skew-join handling
(`spark.sql.adaptive.skewJoin.enabled`); otherwise salt the key or
repartition on a better key.
