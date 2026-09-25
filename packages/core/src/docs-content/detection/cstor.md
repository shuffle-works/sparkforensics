### `CSTOR`: Cache storage {#cstor}

A persisted dataset is not fully cached in memory, or is spilling to disk.
Raise executor memory, or shrink the cached dataset.

The cached-partition counts and sizes come from `SparkListenerBlockUpdated`
events, which Spark writes only when
`spark.eventLog.logBlockUpdates.enabled=true`. Since Spark 2.3 the RDD
storage figures in stage-submission events are always 0, so they are used
only for older logs that still carry real values. When a run persists RDDs
but its log has neither and block-update logging was off, the check reports that the cache could not be
checked instead of passing it: turn `spark.eventLog.logBlockUpdates.enabled`
on and rerun to measure eviction and disk spillover.
