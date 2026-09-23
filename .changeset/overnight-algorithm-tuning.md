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

Estimates: `tinyTask` recoverable time now uses the stage's own measured per-task overhead (task
wall time minus executor run time) spread over the stage's achieved concurrency, instead of an
assumed 50ms per task summed serially across tasks that ran in parallel.

Estimates: `stageSlowness` no longer claims "stage duration minus 15 minutes" as recoverable. Its
estimate is now what more partitions could recover: the time the stage's tasks were running, spread
over the cores the stage left unused. A stage that sat queued with its one short task, or that
already ran more tasks than the cluster had cores, no longer grades critical, and a long
single-task stage now does. Stage messages carry a new `taskActiveMs` field for this.

Parser: a stage whose `StageSubmitted` event carries no submission time (older Spark) now takes it
from `StageCompleted`, instead of starting at epoch 0 and reading as a decades-long stage.

Thresholds: `straggler` also fires on a 2.5-5% straggler share when the stage's recoverable tail
already clears the 0.5% runtime floor. In a large stage, the few tasks that gate it for tens of
seconds can be under 5% of its tasks.

Parser: the NDJSON line splitter finds newlines in the decoded text instead of mapping raw-byte
offsets to UTF-16 offsets, 4.4% faster parsing across 14 real logs with identical output.

Analyzer: plan-shape fingerprints fold each child in as a fixed-length digest instead of its
full fingerprint string, and scan classification rejects non-scan plan nodes before running its
regexes and is computed once per node. `analyze()` is 40% faster across 14 real logs (1131ms to
678ms; 729ms to 311ms on the largest), with identical findings.
