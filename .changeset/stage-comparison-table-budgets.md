---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-web": minor
---

The dashboard comparison page now shows a **Stages compared** table, and comparisons can be gated per paired stage.

The table lists each pair from `stagePairs` with its change in run time, CPU time, spill, input, output and shuffle, sorted by the absolute run-time change, with the pair's `quality` and `score`. Re-planned groups and unmatched stages are listed below it, and every stage links to its detail in that run's dashboard.

New budget `max-stage-regression`: `--stage-regression-budget <metric>:<pct>` (repeatable, needs `--baseline`) on the CLI and `stageRegressionBudgets` on MCP `evaluate_budgets` fail when any paired stage's `executorRunTime`, `executorCpuTime`, `memoryBytesSpilled`, `diskBytesSpilled`, `shuffleReadBytes` or `shuffleWriteBytes` grew by more than the percentage. By default only `exact` and `structural` pairs count; `--stage-quality` and `stageQualities` choose the qualities. It is inconclusive when no eligible stage pairs. `inputBytes` and `outputBytes` are refused (usage error on the CLI, call error on MCP) because volume has no regression direction. Existing budgets and exit codes are unchanged, and `confidence` still does not affect any budget.
