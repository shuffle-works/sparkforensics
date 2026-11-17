---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

Budgets now report failed jobs. `evaluate_budgets` and the CLI add an always-on `no-failed-jobs` result: a run with one or more failed jobs is a violation that names the count and the failed job ids, and a run with none passes. **The CLI now exits 1 for a run with a failed job, with or without budget flags**, where it passed or exited 3 before. Every budget result list gains a `no-failed-jobs` row, and the JSON envelope schema accepts the new name. `maxFailedTaskRatePct` is unchanged.
