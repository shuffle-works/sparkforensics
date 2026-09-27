---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics-web": minor
---

The evidence report and MCP `get_run_summary` now say how the run ended, as the dashboard verdict does. The report summary gains `outcome` (`failedJobs`, `totalJobs`, `failureReason`, `failureReasonStageId`), and the Markdown adds a line such as "Outcome: 1 of 3 jobs failed. Spark's recorded reason (stage 1): ...", quoting only the first line of Spark's reason. `get_run_summary` returns the same four fields next to `runComplete`. With `redact`, its app identity now comes from the same redacted report, so a host in the app name and in the failure reason get the same pseudonym.
