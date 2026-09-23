---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Tuning reference refreshed to spark-tuning-reference@1d0f90d: corrected detector threshold tables
for failures, GC, shuffle, skew, small files, straggler, tiny tasks and utilization, and new
sub-anchor sections for autoscaling churn (cluster config), cache utilization (memory model),
speculation waste (straggler), partition sizing (shuffle), core locality and caching opportunity
(utilization). The reference is now pinned to an exact upstream commit, recorded in the vendored
docs as `upstream.json`.
