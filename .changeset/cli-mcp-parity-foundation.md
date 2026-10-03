---
"sparkforensics-cli": patch
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

The CLI and the MCP server now build their run and comparison output from the same core functions, and a contract test diffs the two surfaces on public corpus logs.

Changes to the MCP server's output (intentional, additive):

- `diagnose_run` returns `writeTargets`, `metrics` and `effectiveConf` by default, the same blocks as the CLI's JSON report. Clients that read only the fields it returned before see no difference.
- `compare_runs` returns `metrics` and `findings`, the names the CLI's `comparison` object uses. `metricDeltas` and `findingsDelta` still carry the same values and are deprecated: they will be removed in the next release.
- `evaluate_budgets` takes `regressionBudgets`, an array of `{ metric, maxPct }`, matching the CLI's repeated `--regression-budget`. A metric budgeted twice fails the call, as it does on the CLI.

The CLI's JSON, Markdown and NDJSON output, its `[violation] name: detail` stderr line and its exit codes are unchanged.
