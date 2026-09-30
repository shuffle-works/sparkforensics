---
"sparkforensics-cli": minor
"sparkforensics-mcp": patch
---

The CLI compares several candidate logs against one baseline in a single call, and gates on several regression budgets at once.

Pass two or more logs with `--baseline` (or `--format ndjson` for one) and the CLI parses the baseline once and writes one NDJSON line per candidate: `log`, `status` (`pass`, `violation`, `inconclusive` or `error`), `exitCode`, `error`, `budgets`, `candidate` and `comparison`, the last two matching the single-candidate JSON output. A candidate that cannot be read or parsed gets an `error` line with `exitCode` 4 and does not stop the others. The exit code is the worst line, in the order 6, 5, 4, 1, 3, 0. With `--redact`, `log` and the stderr prefixes name each candidate by position (`candidate-1`, `candidate-2`, ...) and an error line carries a generic message, so no candidate path reaches the output. In single- and multi-log mode alike, `--redact` also replaces the error text of an unreadable baseline or candidate with a message naming only its role (`The baseline could not be read or parsed.`), since that text can carry the log path.

`--regression-budget <metric>:<pct>` (repeatable) and `--budgets <file.json>` (`{"regression": {"<metric>": <pct>}}`) add regression budgets. The existing `--max-regression-pct`/`--regression-metric` pair counts as one more budget. An unknown metric, an unknown file key, a malformed percentage, or a metric budgeted twice is a usage error (exit 2).

`max-regression` budget results now carry `metric`, also in the MCP `evaluate_budgets` results.

**Behavior change:** the CLI's exit codes are split so a caller can tell failures apart. Exit 2 now means a usage error only (bad flags or arguments, including a malformed `--shs-base-url`, `--app-id` or `--attempt-id`, or an invalid `--thresholds` or `--budgets` file). An unreadable or unparsable candidate log, which used to exit 2, now exits 4, and so does a failed `--shs-base-url` fetch. An unreadable or unparsable `--baseline` exits 5, and an internal error, including a failed `--export-html` and any unhandled failure, exits 6 (it used to exit 2, or 1 from an unhandled crash). 0, 1 and 3 are unchanged. When several apply, the worst wins in the order 6, 5, 4, 1, 3, 0.
