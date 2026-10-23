---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

A repeated plan subtree under a `showString` or `collect` action drops to the info band and no longer leads the verdict. Repeats that read different versions of the same Delta table, where the scan records the version, no longer get cache advice. Repeats under `count` and `save` keep their ranking.
