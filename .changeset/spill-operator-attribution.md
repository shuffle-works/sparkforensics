---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The spill finding names the operators that spilled, with their plan node ids and spill size, and shows the memory spill as a multiple of the stage's input. From 10x it says the rows are wide. Its evidence adds `operators`, `spillToInputRatio`, `wideRows` and `exchanges` (column count and bytes per row).
