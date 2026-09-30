### `COLD`: Executor cold start {#cold}

The first stage waited more than 30 s for an executor. Keep a warm pool of
executors, or, with dynamic allocation, raise
`spark.dynamicAllocation.minExecutors`/`initialExecutors` so the app doesn't
scale up from zero.
