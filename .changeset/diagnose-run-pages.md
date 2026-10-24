---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

`diagnose_run` returns a JSON answer longer than `pageChars` (default 50,000 characters) in pages. The first page has the verdict and as many rows as fit, and `pagination.nextCursor` is the `cursor` for the next page. With `format: "md"`, `structuredContent` holds the Markdown as `markdown`. `get_finding_evidence` accepts a `source` and an optional `appId` in place of a `runId`, so a finding can be read after a server restart.
