---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

Detector thresholds can now be tuned per run. `sparkforensics-analyze --thresholds <file>` and `sparkforensics-mcp --thresholds <file>` read a JSON file of overrides keyed by detector and threshold name, such as `{"skew": {"ratioWarn": 6}}`; the names, units and defaults are the report's `detectors` catalog. A file that can't be read, isn't valid JSON, or names an unknown detector, an unknown threshold or a value of the wrong shape stops the CLI with exit code 2 and stops the MCP server from starting. Every finding and clean check from a tuned detector carries `tunedThresholds` (each override's value and default), and a tuned finding's `validationRequired` says its impact estimate is unvalidated, since the estimates are calibrated against the defaults. The report adds `summary.tunedThresholds`, and the MCP `diagnose_run`, `compare_runs` and `evaluate_budgets` results a top-level `tunedThresholds`. A run without the flag produces the same report as before. `--export-html` keeps the default thresholds, like the dashboard, and says so on stderr.
