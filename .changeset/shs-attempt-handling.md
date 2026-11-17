---
"sparkforensics-mcp": patch
"sparkforensics-cli": patch
---

History Server fetches without an attempt id now check the application's attempts first. An application with several attempts fails before any download, with a message that lists the attempt ids and names the argument that picks one: `source.attemptId` in MCP, `--attempt-id`, `--app-id <id>:<attempt>` or `--baseline-attempt-id` in the CLI. An invalid History Server request reports each bad field. `get_run_summary` returns `app.attemptId`, `null` when the run has none.
