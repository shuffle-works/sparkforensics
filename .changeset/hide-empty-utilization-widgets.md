---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Executor Utilization and Memory Utilization no longer show a "no issues"
card in the dashboard when they have zero findings; they now collapse into
the Clean-checks row like every other widget instead of being always
mounted. Core Usage by Locality keeps the always-mounted treatment.

The CLI's `--format md/json` report and MCP's `diagnose_run` output change
to match: when Executor or Memory Utilization has zero findings, it's now
listed under "checked and clean" like every other detector, instead of
being silently omitted from that section.
