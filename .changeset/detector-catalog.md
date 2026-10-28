---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

`sparkforensics-analyze detectors` and the `list_detectors` MCP tool list every finding type the detectors can report, with no event log. Each record has the tag, outcome family, one-sentence description, scope, fix effort, default thresholds, docs paths and the budget flag that gates the type. Both take a finding type to list only that one. The MCP server now has nine tools.
