---
"sparkforensics-mcp": minor
"sparkforensics-cli": patch
---

**Breaking (MCP):** `evaluate_budgets` with two runs now applies the absolute budgets
(`maxRuntimeMs`, `maxSpillGb`, `maxSkewRatio`, `maxFailedTaskRatePct`, `minEfficiencyPct`) to the
candidate run (`sourceB`/`runIdB`), matching `sparkforensics-analyze --baseline`. Before, they were
evaluated on `source`/`runId`, the regression baseline. The response's `runId` is now the evaluated
run (the candidate when two runs are given), and a new `baselineRunId` names the baseline. The tool
also always reports a `run-complete` result with status `inconclusive` when the evaluated run has no
ApplicationEnd event, the same check the CLI uses to exit 3, so a truncated log no longer reads as
a pass. Clients that passed the run to gate as `source` alongside a `sourceB` must swap the two.

The CLI now takes its `run-complete` check from the same shared budget evaluation. Its output and
exit codes are unchanged.
