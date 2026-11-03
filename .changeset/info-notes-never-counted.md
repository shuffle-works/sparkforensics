---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

An info note is never something to act on. The verdict, in the dashboard, the CLI report and the MCP `diagnose_run` result, builds its steps, leads and finding count from critical and warning findings only, so the verdict count and the report's "Findings to act on" use one rule. A run with only info notes reads "No findings to fix right now." and `notesHidden` counts the notes. The dashboard's evidence export lists critical and warning findings by default, as the CLI and MCP do, and says how many notes it left out.
