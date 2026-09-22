### `MEM`: Memory utilization {#mem}

Executor memory or core capacity may be over- or under-provisioned. Some
detail here needs `spark.eventLog.logStageExecutorMetrics=true` on the run
being analyzed; without it, per-executor memory usage can't be broken down.
Review `spark.executor.memory` and executor count if allocated memory sat
largely idle over the run. That idle-memory variant self-flags a confidence
that scales with how far the estimated waste sits past a 1.5x buffer: it
estimates waste from allocated-versus-used memory-time. Check it against
the Spark UI before resizing anything.
