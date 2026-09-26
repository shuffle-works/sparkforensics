---
"sparkforensics-mcp": minor
"sparkforensics-cli": patch
"sparkforensics-server": minor
---

**Breaking (MCP):** `evaluate_budgets` with two runs now applies the absolute budgets
(`maxRuntimeMs`, `maxSpillGb`, `maxSkewRatio`, `maxFailedTaskRatePct`, `minEfficiencyPct`) to the
candidate run (`sourceB`/`runIdB`), matching `sparkforensics-analyze --baseline`. Before, they were
evaluated on `source`/`runId`, the regression baseline. The tool also always reports a
`run-complete` result with status `inconclusive` when the evaluated run (the candidate, with two
runs) has no ApplicationEnd event, the same check the CLI uses to exit 3, so a truncated log no
longer reads as a pass. Clients that passed the run to gate as `source` alongside a `sourceB` must
swap the two.

The CLI now takes its `run-complete` check from the same shared budget evaluation. Its output and
exit codes are unchanged.
