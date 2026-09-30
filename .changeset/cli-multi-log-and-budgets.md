---
"sparkforensics-cli": minor
"sparkforensics-mcp": patch
"sparkforensics-web": patch
---

The CLI compares several candidate logs against one baseline in a single call, and gates on several regression budgets at once.

Pass two or more logs with `--baseline` (or `--format ndjson` for one) and the CLI parses the baseline once and writes one NDJSON line per candidate: `log`, `status` (`pass`, `violation`, `inconclusive` or `error`), `exitCode`, `error`, `budgets`, `candidate` and `comparison`, the last two matching the single-candidate JSON output. A candidate that cannot be parsed gets an `error` line, counts as inconclusive and does not stop the others. The exit code is the worst line: 2, then 1, then 3, then 0.

`--regression-budget <metric>:<pct>` (repeatable) and `--budgets <file.json>` (`{"regression": {"<metric>": <pct>}}`) add regression budgets. The existing `--max-regression-pct`/`--regression-metric` pair counts as one more budget. An unknown metric, an unknown file key, a malformed percentage, or a metric budgeted twice is a usage error (exit 2).

`max-regression` budget results now carry `metric`, also in the MCP `evaluate_budgets` results. Run comparisons report per-task sums (spill, GC, executor run time, input and output bytes) as unavailable instead of 0 for a run with no usable task records, such as a log cut off before any task ended, in the CLI, the MCP `compare_runs` tool and the dashboard.
