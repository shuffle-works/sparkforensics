---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

`FAIL`, `SFAIL` and `RETRY` findings give a specific fix when the failure text is a known message. A container killed for exceeding memory limits points to `spark.executor.memoryOverhead`. A stage that failed the maximum allowable number of times points to `spark.stage.maxConsecutiveAttempts`. Each adds a structured remediation, and the raw failure text stays on the finding.
