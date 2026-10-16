---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

A task-time `slowHost` finding (`evidence.dimension` `taskTime`) now needs an executor whose mean task duration is further above the median executor's than the stage's own spread of task durations and the executor's task count allow. Before, the ratio of the largest executor mean to the median was enough, so the slowest of 75 executors reached the top of the ratio by chance far more often than the slowest of 3, and its claim as a share of the run could then rate it `critical`.

- The test is a z-score on the log scale of task duration: the executor's mean log duration minus the median executor's, over the stage's task spread divided by the square root of the executor's task count. It must reach `sqrt(2 ln(executors / (2 * outlierAlpha)))`, so the cutoff grows with the number of executors. The new tunable threshold `slowHost.outlierAlpha` defaults to 0.005, which is 3.4 for 3 executors and 4.2 for 75. The ratio tiers, the 1000 ms floor and the byte dimensions are unchanged, and `ratioTiers[2]` is still not read.
- Plugin-visible band change: a task-time `slowHost` finding that a chance gap produced is gone, so a run can lose a `critical` (or `warning`, or `info`) `slowHost` finding it had before. A finding for an executor that is slow against the stage's spread keeps its band, which still comes from its wall-clock claim. On the public corpus the one affected finding is the `critical` task-time `slowHost` on a 1.2 s claim in `pairwise-07`.
- Finding ids, types, fields and matching are unchanged, and report schema 5 and metrics schema 1 stay. The `slowHost` detector is at version 2. Each `executorStats` row of a stage record carries two new additive fields, `logDurationSum` and `logDurationM2`. A stage recorded without them, or with a non-finite value in either, flags no executor on task time.
