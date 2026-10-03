# Regression metric keys

The metric keys that a regression metric or regression budget accepts.

`--regression-metric`, `--regression-budget` and the `--budgets` file (and the
MCP `evaluate_budgets` tool's `regressionMetric`) take one of these keys; the
default for `--regression-metric` is `wallClock`:

- `wallClock`: wall-clock duration
- `executorRunTime`: summed executor run time
- `shuffleSpill`: memory spill (Spark's `memoryBytesSpilled`)
- `diskSpill`: disk spill (Spark's `diskBytesSpilled`)
- `gcTime`: JVM GC time
- `taskSkew`: p95 task skew
- `failedTaskRate`: failed-task rate
- `executorCpuTime`: summed executor CPU time, in milliseconds (unavailable
  for a run whose log never recorded it)
- `allocatedCoreHours`: executor cores times hours alive, see
  [Allocation](./ci-and-automation.md#allocation)

Four more keys, `inputBytes`, `outputBytes`, `taskCount` and
`executorsAdded`, measure workload volume rather than performance. They have
no better or worse direction, so a regression budget on one of them reports
`inconclusive` whenever the value changes, and passes when it doesn't.
