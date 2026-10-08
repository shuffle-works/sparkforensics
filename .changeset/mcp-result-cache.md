---
'sparkforensics-cli': patch
'sparkforensics-mcp': patch
'sparkforensics-server': patch
---

Repeated MCP `diagnose_run` and `compare_runs` calls on the same runs return a cached result instead of recomputing the run metrics block and the whole comparison. Cached comparisons are keyed by both runs, thresholds, redaction, path normalization and view, and expire with the runs they came from. Output is unchanged.
