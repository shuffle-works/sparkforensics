---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

`sparkforensics-analyze detectors` and the `list_detectors` MCP tool list every finding type the detectors can report, with no event log. Each record has the tag, outcome family, one-sentence description, scope, fix effort, thresholds (the tuned ones under `--thresholds`), docs paths and the budget flag that gates the type. Both filter by type, tag, family and scope. The MCP server now has nine tools.
