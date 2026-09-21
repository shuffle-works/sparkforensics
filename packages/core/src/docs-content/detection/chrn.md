### `CHRN`: Autoscaling churn {#chrn}

Executors are stood up and torn down again before they can do useful work:
re-provisioning churn rather than normal scale-down. Raise
`spark.dynamicAllocation.executorIdleTimeout`, or widen the
`minExecutors`/`maxExecutors` bounds to reduce flapping. Self-flagged
low-confidence: a design spike, not yet validated against real-world runs.
