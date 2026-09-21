---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Fix Executor Utilization and Memory Utilization overstating idle time and
wasted-memory savings on runs with executor churn (spot preemption,
`dynamicAllocation` replacement): both now measure real concurrent capacity
instead of summing every executor that ever existed.

`maxPartitionTooBig`, a hardcoded-critical OOM/crash-risk finding, no longer
gets silently downgraded on long-running jobs by the generic wall-clock-based
severity grading; it keeps its critical severity regardless of how small its
modeled time savings are relative to the run.

Cold Start and Executor Utilization no longer silently skip a run whose
`startTime` is literally `0`.

Task Skew and Straggler findings on the same stage now call out that they
can describe the same wasted time and shouldn't be added together. Task
Skew, Straggler, and GC Pressure now disclose that their thresholds are
unvalidated, matching other findings with comparable uncertainty.
