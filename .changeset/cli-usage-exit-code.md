---
"sparkforensics-cli": patch
---

`sparkforensics-analyze` now exits 2 with the usage text on an unknown flag, a flag missing its
value, or an unknown `--regression-metric` key. Before, a bad flag exited 1 (budget violated) with
a stack trace, and a misspelled metric exited 3 (inconclusive). Core exports
`COMPARISON_METRIC_KEYS`, the list of keys a run comparison reports.
