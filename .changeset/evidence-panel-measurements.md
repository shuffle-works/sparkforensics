---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

The evidence panel under "Show evidence" always shows evidence. The grid, the Full app report and the stage dialog are unchanged. Executor Utilization shows its core-time breakdown and the core usage chart, Memory Utilization the chart, the heap peak or the allocated memory-time. The panel leaves out a core usage chart with fewer than 3 points. Excessive Small Files shows the average file size, Config Audit the audited setting when it has no docs link, Shuffle I/O the per-task read sizes and Speculation Waste the speculative task count. The memory waste finding carries its allocated memory-time for the panel; the CLI and MCP evidence rows leave it out.
