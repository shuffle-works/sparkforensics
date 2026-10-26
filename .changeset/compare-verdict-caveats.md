---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

The comparison verdict calls out differences that make a time gap hard to read. It says when mean executors differ by more than 1.5 times and the wall clock moved the way fewer or more executors predict, so the wall-clock change reflects executor availability, names a differing `spark.yarn.queue`, and says the plans differ when more than 20% of the baseline's stages have no match (re-planned leftovers included) or the task count changes by more than 25%, with the unmatched stages' share of the baseline's executor run time. A differing `spark.jars`, `spark.submit.pyFiles` or `spark.yarn.dist.*` path reads as a likely code change. When every stage pairs, a task count change reads as a task count change, not a plan difference, and also shows when configuration and plan agree. `comparability.caveats` carries the same facts. The CLI flags `--executor-ratio`, `--unmatched-stages-pct` and `--task-count-change-pct`, and the `compare_runs` inputs `executorRatio`, `unmatchedShare` and `taskCountChange`, change the limits.
