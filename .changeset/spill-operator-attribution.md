---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The spill finding names the operators of the stage that spilled (`Sort`, a `Sort` feeding a `SortMergeJoin`, hash aggregates and `Window`) with their plan node ids and reported spill size, and shows the memory spill as a multiple of the stage's input plus shuffle read. At 10x or more it says the rows are wide. Its evidence adds `operators`, `spillToInputRatio`, `wideRows` and `exchanges`, where each exchange the operators read reports its column count and estimated bytes per row. The compact `diagnose_run` view adds an `evidenceLines` field to a spill row: one line for the operators and ratio, then one short line per exchange.
