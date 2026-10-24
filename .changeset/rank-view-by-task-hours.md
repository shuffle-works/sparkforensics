---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The dashboard's widget lists and the plan graph's "Next problem" order findings as `verdict.steps` does (stage task time, then potential savings), and show the Impact / Stage toggle whenever that order can move a row. The spill finding's modeled serialization and sort CPU now counts in its `coreTimeMs` and in the cost lane.
