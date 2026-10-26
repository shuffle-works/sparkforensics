---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

`SPARKFORENSICS_SHS_BASE_URL` sets the default History Server. `sparkforensics-analyze` uses it for `--app-id` and `--baseline-app-id` when no URL flag is given, and `sparkforensics-mcp` uses it, or its new `--shs-base-url` flag, for a `source` or `list_runs` call without `shsBaseUrl`. A flag or argument takes precedence. An `--app-id` with no History Server now names the flag and the variable. The Markdown comparison prints metric deltas and data volume in readable units with the percent change, and labels a change inside the noise band `within noise`. JSON output is unchanged.
