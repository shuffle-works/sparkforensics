---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

`diagnose_run` returns a JSON answer longer than 50,000 characters in pages. The first page has the verdict and as many rows as fit, and `pagination.nextCursor` is the `cursor` for the next page. With `format: "md"`, `structuredContent` holds the Markdown as `markdown`. `get_finding_evidence` takes an optional `runId`, or a `source` and an optional `appId` instead, so a finding can be read after a server restart. A `cursor` that does not belong to the run and filters returns the `invalid-cursor` error code.
