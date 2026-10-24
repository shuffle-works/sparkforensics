---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

A repeated plan subtree under a `show`, `showString` or `collect` action is informational and no longer leads the verdict. Repeats that read different recorded versions of one Delta table get no cache advice.
