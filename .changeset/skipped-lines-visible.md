---
'sparkforensics-cli': patch
'sparkforensics-mcp': patch
'sparkforensics-server': patch
---

A log with corrupt or unparseable lines no longer looks clean. The report's `summary.skippedLines` and the MCP `get_run_summary` carry the count of skipped lines (`0` for a clean log), and the Markdown report adds a `Skipped lines` line when it is above `0`. The budget gate adds an inconclusive `parse-incomplete` result for such a log, in the CLI, in each line of a multi-log run and in the MCP `evaluate_budgets` tool, so a passing budget on a damaged log exits `3` instead of `0`. Any skipped line makes the CLI exit `3` (inconclusive, never `1`), even with no budget flags. The count also includes events that fail schema validation, such as a plan nested deeper than 500 levels. With a baseline, the comparison's `baselineSkippedLines` carries the baseline's count, the Markdown comparison adds a `Baseline skipped lines` line, and `parse-incomplete` also fires for a damaged baseline, naming which run lost lines.
