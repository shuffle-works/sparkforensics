---
"sparkforensics-mcp": patch
"sparkforensics-cli": patch
---

History Server fetches without an attempt id now check the application's attempts first. An application with several attempts fails before any download, with a message that lists the attempt ids and names `source.attemptId`. An invalid History Server request reports each bad field. `get_run_summary` returns `app.attemptId` when the run has one.
