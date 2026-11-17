---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

The `LOCAL` band follows the modeled fetch cost as a share of run task time, so a high non-local ratio on a cheap run is no longer critical. Impact figures print in one unit per category (GB-h for memory, core-h for core time) whatever their size. Compact finding rows gain `impactCoreMs`, the finding's core time in milliseconds, for ranking findings by impact.
