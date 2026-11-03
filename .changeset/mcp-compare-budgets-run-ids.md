---
"sparkforensics-mcp": minor
---

`compare_runs` no longer returns `metricDeltas` and `findingsDelta`; read `metrics` and `findings`, which hold the same values. It takes `baselineRunId` and `candidateRunId` and returns both. `runIdA` and `runIdB` still work as input and output, are deprecated, and are removed in 0.13.0. `evaluate_budgets` returns `candidateRunId`, the run the budgets were evaluated on, and `baselineRunId` when given two runs, so a result is not read as the wrong run's. Its `runId` still holds the first run's id, is deprecated, and is removed in 0.13.0.
