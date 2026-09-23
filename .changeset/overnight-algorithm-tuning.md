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

Estimates: low-GC `gc` findings (an over-provisioning signal) no longer claim the stage's GC time as
recoverable wall-clock time, since their fix, less executor memory, raises GC rather than removing
it. They are now informational and keep their `info` band.

Estimates: `shuffle` and `spill` recoverable time now spreads the stage's shuffle-read or disk-spill
bytes over every executor that ran it (one ~1 Gbps link or ~200 MB/s disk each) instead of pushing
the whole cluster's bytes through a single link or disk. On the largest real log the old figures
claimed 721 minutes of shuffle and spill savings on a 458-minute run; they now claim 51.
