---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

`diagnose_run` returns a large run in pages. A JSON answer longer than `pageChars` (default 50,000 characters) carries the verdict and the fixed blocks with as many rows as fit, and `pagination.nextCursor` is the `cursor` that fetches the next page. The paged lists are `findings`, `cleanChecks`, `notRunChecks`, `metrics.stages` and `writeTargets.writes`. An answer that fits in one page is unchanged. `get_finding_evidence` accepts a `source` and an `appId` instead of a `runId`, so a finding can be read after a server restart.
