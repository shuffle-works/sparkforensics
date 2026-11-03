---
"sparkforensics-mcp": minor
---

A call with a wrong argument now fails with `invalid-argument`, not `access-or-upstream-failure`, so an agent corrects the call instead of retrying or reporting an outage. This covers a missing `source` and `runId`, `appId` without a `source`, neither `dir` nor `shsBaseUrl` with no default History Server, a `normalizePath` or `ignoreConf` pattern that does not compile, and budget arguments that conflict or are incomplete. The full list of error codes is in the MCP tools reference.
