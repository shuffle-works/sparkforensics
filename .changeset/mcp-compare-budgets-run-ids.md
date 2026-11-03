---
"sparkforensics-mcp": minor
---

`compare_runs` no longer returns `metricDeltas`, `findingsDelta`, `runIdA` or `runIdB`. Use `metrics`, `findings`, `baselineRunId` and `candidateRunId`. Its inputs `runIdA` and `runIdB` are replaced by `baselineRunId` and `candidateRunId`. `evaluate_budgets` no longer returns `runId`. Use `candidateRunId`, the run the budgets were evaluated on, and `baselineRunId`, present with two runs.
