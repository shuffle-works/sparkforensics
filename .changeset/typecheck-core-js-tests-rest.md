---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

The core `SqlExecution` type declares `sparkPlanInfo` and `hadAdaptiveUpdate`, which the parser already sets on the executions it sends.
