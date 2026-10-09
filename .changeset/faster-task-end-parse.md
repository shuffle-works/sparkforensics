---
"@sparkforensics/core": patch
---

Parsing a large event log is about 8% faster: a TaskEnd's accumulator IDs skip schema validation, a stage's repeated accumulator ID list is recorded once, and the executor-metric field table is built once. Findings and estimates are unchanged.
