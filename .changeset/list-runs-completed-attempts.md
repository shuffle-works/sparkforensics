---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics": minor
---

`list_runs` rows from a History Server carry `completed` and `attemptCount`, plus `attemptIds` when an application has several attempts, so an agent can pick `source.attemptId` before it diagnoses. The new `includeFailedJobs` input adds a `failedJobs` count per row, at one extra History Server request per returned row.
