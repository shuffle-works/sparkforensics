---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The Spill widget lists the operators that spilled, the spill-to-input ratio and the width of the rows they read. The plan graph shows the column count and bytes per row on every exchange. The parser keeps the `Input [N]` line of each Exchange in the plan description, so an exchange above a join or an aggregate gets an exact column count. On a scan stage the spill finding says a high ratio can also come from Parquet compression.
