---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Executor memory findings are measured from the executor metrics every Spark 3+ event log records on each task end, not only from stage executor metrics (`spark.eventLog.logStageExecutorMetrics`, off by default). Finding counts and the `memoryUtilization` shapes change, so a saved baseline, budget or ranking built on them needs refreshing.

- `memoryUtilization` reads a per-executor heap peak from task ends, taking the larger of that and any stage executor metrics peak, and ignores the driver and all-zero rows (local mode). Peaks are sampled at executor heartbeat, so the finding text calls them a lower bound. The "memory data unavailable" note now means the log has no non-zero peak (Spark before 3.0, local mode) and no longer suggests a logging switch.
- Over-provisioning is judged once, on the executor with the highest heap peak, because `spark.executor.memory` is one setting for every executor. The `heapOverProvisioned` finding carries `executorCount` and `executorSeconds`, and its waste figure is the unused heap times the seconds the executors were alive. It replaces one finding per executor.
- The `heapNearCapacity` finding is removed. `JVMHeapMemory` is heap used including uncollected garbage, so a peak near the heap limit is normal JVM behaviour and not evidence of memory pressure.
- The low-GC "memory may be over-provisioned" note on `gc` is emitted only when the log has no measured heap peak. On the private logs it was the most frequent finding.
- The `wasteModel` variant divides summed task run time by the cores per executor before comparing it with executor-seconds, and is skipped when the cores are unknown. Used memory was overstated by the core count, so the finding now fires on more runs.
- Parsing: `Task Executor Metrics` is read from every task end into `runAggregates.executorPeakMetrics`.
