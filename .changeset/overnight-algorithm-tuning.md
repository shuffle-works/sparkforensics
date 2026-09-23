---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Parser: SQL execution events no longer carry or retain `physicalPlanDescription` (Spark's text
rendering of the plan, which nothing reads), and the raw `sparkPlanInfo` is released once its plan
tree resolves. On a 3.5 GB decompressed real log this cut parse time 7.8% and peak RSS 21%, with
identical findings.

Estimates: `skew` and `straggler` recoverable time is no longer floored at the stage's current
longest task, the very task their fix shortens. A stage gated by one straggler used to report
about zero recoverable time, and could be dropped by the runtime floor. Their floor is now the
longest task the fix leaves or the stage's core work over every core. Against a task-level
replay of 765 flagged stages on 14 real logs, estimates more than 2x too low fell from 199 to 11.
