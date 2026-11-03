---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

A run's timing and idle share each have one rule that every surface reads. `runComplete` (MCP `diagnose_run` and `get_run_summary`, and the CLI metrics block) is false only when the log has an application start and no end, so it agrees with the `incompleteRun` finding: a log with no application start time now reports `true`. The verdict's idle note and the Scorecard's Unused core time flag use the `utilization` thresholds: notable from `1 - minUtil` idle, critical from `1 - criticalUtil` idle. `utilization` gains the `criticalUtil` threshold (default 0.30), and a `--thresholds` override of either moves the finding, the note and the flag together. The utilization, idle-cores, `--min-efficiency` and Scorecard figures all read one idle share, so a log whose tasks ran outside every stage window reads its true busy share.
