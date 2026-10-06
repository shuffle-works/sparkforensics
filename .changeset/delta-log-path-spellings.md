---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics-web": patch
---

`writeTargets` names the table of a Delta `MERGE`, `UPDATE` or `DELETE` when its plans print the same local table as both `file:/path` and `file:///path`. The two spellings are one path, so the write reports `file:///path` instead of a `null` target.
