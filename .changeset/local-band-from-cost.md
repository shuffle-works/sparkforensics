---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

The `LOCAL` band follows the modeled fetch cost as a share of run task time, so a high non-local ratio on a cheap run is no longer critical. Impact figures print in one unit per category (GB-h for memory, core-h for core time) whatever their size. Every finding row, in the CLI JSON report and in both MCP views, gains `rankImpactMs`, a millisecond ranking figure on the axis of `rankCostMs`, for ranking findings by impact.
