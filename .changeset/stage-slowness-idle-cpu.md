---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Estimates: a `stageSlowness` finding claims no recoverable time when its stage read no input and
no shuffle bytes and its tasks spent under 1% of their run time on CPU, since they were waiting on
something outside Spark (a JDBC read, a file listing) that more partitions don't split. This
replaces the rule that zeroed any stage reading no input and no shuffle bytes: a stage that computes
from generated data, or only writes output, keeps its claim.
Stages running Python through `PythonRDD`, and logs from Spark versions without CPU time, are
never treated as idle, since their CPU time doesn't show the work.
