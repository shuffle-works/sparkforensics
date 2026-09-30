---
"sparkforensics-cli": minor
"sparkforensics-mcp": patch
---

The CLI compares several candidate logs against one baseline in a single call, and gates on several regression budgets at once.

Pass two or more logs with `--baseline` (or `--format ndjson` for one) and the CLI parses the baseline once and writes one NDJSON line per candidate: `log`, `status` (`pass`, `violation`, `inconclusive` or `error`), `exitCode`, `error`, `budgets`, `candidate` and `comparison`, the last two matching the single-candidate JSON output. A candidate that cannot be read or parsed gets an `error` line with `exitCode` 2 and does not stop the others. The exit code is the worst line: 2, then 1, then 3, then 0. With `--redact`, `log` and the stderr prefixes name each candidate by position (`candidate-1`, `candidate-2`, ...) and an error line carries a generic message, so no candidate path reaches the output.

`--regression-budget <metric>:<pct>` (repeatable) and `--budgets <file.json>` (`{"regression": {"<metric>": <pct>}}`) add regression budgets. The existing `--max-regression-pct`/`--regression-metric` pair counts as one more budget. An unknown metric, an unknown file key, a malformed percentage, or a metric budgeted twice is a usage error (exit 2).

`max-regression` budget results now carry `metric`, also in the MCP `evaluate_budgets` results.
