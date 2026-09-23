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
678ms; 729ms to 311ms on the largest), with identical findings. Join-detail normalization no
longer rescans each identifier from every letter, another 8% (692ms to 636ms).

Parser: a `physicalPlanDescription` value that spans decompressed chunks is dropped as raw bytes
instead of being decoded and then cut out as text. Parsing the largest real log is 11.7% faster
(12.56s to 11.09s) with peak memory down from 708MB to 602MB; 6.8% faster across 14 real logs,
with identical output.

Parser: a `TaskEnd` whose accumulator updates include a JSON array (Spark 2.x's
`internal.metrics.updatedBlockStatuses`, or block-status tracking turned on) is no longer rejected
and dropped from its stage's stats. Only the accumulable `ID` is validated now, which also makes
parsing 3.7% faster across 14 real logs.

Estimates: `duplicatePlanSubtree` claims only repeated work it can see. Repeats with the same
shape but different filters, columns or tables are informational with low confidence. Each stage
now counts only the repeated operators' share of it, and only for its task-active time, so a
stage shared with a join or left waiting for cores no longer counts whole. Across 14 real logs,
duplicate-subtree claims fell from 2307 to 108 minutes; before, three logs claimed more duplicate
time than their whole run.

Thresholds: `stageShape`'s under-parallelization rule skips stages shorter than 0.5% of the run,
the same runtime floor the tiered detectors use: parallelizing a stage can't save more than its
own duration. That was 2839 of 3005 such findings across 14 real logs.

CLI and MCP: zstd event logs decompress with Node's native zlib zstd, one frame at a time, when
the running Node has it (22.15+ or 23.8+); older Nodes and the browser keep the bundled decoder.
Parsing the 14 real logs is 42% faster (22.3s to 13.0s; the largest log 10.7s to 6.4s) with
identical output. Logs fetched from a Spark History Server take the same path (2.3s to 1.0s on
a 566MB log).

Estimates: `skew` and `straggler` count a tail of many slow tasks as their summed excess over
the median spread across the stage's peak concurrent tasks, not just the longest task's excess.
Against a task-level replay of 31 runs, estimates within 2x of the replay went from 56 of 78 to
79 of 85, none are now more than 2x under (was 16), and skew recall rose from 0.60 to 0.73 with
no loss of precision.

Estimates and bands: `coldStart` measures the wait from the first stage to the first executor,
not the driver's own startup before its first job. That removes 6 false positives on 14 real logs
and 6 on the corpus, where executors were up long before the first stage. `slowHost` byte-imbalance
findings on stages shorter than 0.5% of the run are informational (66 of 90 warning/critical). A
`smallFiles` read spreads its per-file cost over the tasks that opened the files in parallel.

Parsing: an adaptive query execution update that a later update for the same running SQL
execution replaces is no longer parsed, since only the last plan is ever used. Parsing the 14
real logs is 13% faster (13.1s to 11.3s; the largest log 6.3s to 5.4s) with identical findings.

Parsing: large decompressed chunks are decoded in 512 KiB slices, so a SQL event's
plan text is dropped undecoded even when one zstd frame holds all of it. On the largest real
log that is 1.8 GB of text never decoded, and its parse is 13% faster (5.4s to 4.7s).

Parsing: a task-end event's accumulator IDs are read without parsing the rest of each entry,
which is 71% of those events' bytes. Parsing the 14 real logs is 11% faster (10.6s to 9.4s) and
the 52 corpus logs 8% faster, with identical findings.

Dashboard: zstd event logs decompress about 4x faster in the browser (the bundled decoder
decodes every block into one reused buffer instead of allocating and shifting a window per frame
and a buffer per block, and copies long runs natively), with byte-identical output on the 14 real
logs. Decompressing the largest one in Chrome takes 2.9s instead of 11.6s.

CLI and MCP: large zstd frames of a local event log decompress on Node's threadpool while the
main thread parses. Parsing the 14 real logs is 14% faster (9.4s to 8.1s; the largest log 4.2s
to 3.2s) with identical findings, for up to 139 MB more peak memory.

Estimates: the `skew` and `straggler` core-work floor now leaves out the task time their fix
removes. A stage whose stragglers were most of its core time was floored near its own duration:
one real stage claimed 5.9s where a task-level replay recovers 38.7s. Against that replay over 65
runs, estimates within 2x of it went from 88 of 95 to 97 of 103 and mean absolute error from
7.55s to 5.18s; skew recall rose from 0.76 to 0.81 (precision 0.98 to 0.96).

Estimates: a `straggler` claim runs from the stage's longest task down to the longest task the
fix leaves (the longest one at or under 4x the median), not down to the median: a stage with a
task just under 4x the median still waits on it. Stage messages carry a new
`longestNonStragglerMs` field for this. Against the task-level replay over 65 runs, estimates
more than 2x too high fell from 6 to 4 and mean absolute error from 5.18s to 4.49s.

Parsing: an adaptive query execution update is recognized from the first and last pieces of its
line as decoded, so an update that a later one replaces is no longer copied into one string only
to be dropped. Parsing the 14 real logs is 3% faster (8.05s to 7.80s; the largest log 6%, 3.16s
to 2.97s) with identical findings.

Estimates: `retryWaste` no longer claims the summed time of its wasted attempts as wall-clock when
those attempts ran side by side. When every wasted attempt is sampled, the claim is the longest
retry chain (one task's repeated failures) times the mean wasted attempt, or the summed time spread
over the stage's slots when larger. Four tasks lost with one executor on a real stage claimed
146.6s and now claim 36.6s.

Estimates: a `shuffle` claim can no longer exceed the shuffle fetch wait its tasks measured,
converted to wall-clock at the stage's average concurrency. The per-link bandwidth model can't
see whether reads stalled the tasks: on 14 real logs it claimed 2780s over 284 shuffle findings,
and the capped figure is 256s. Five of the ten warning or critical shuffle findings had about
zero fetch wait and are now informational.

Thresholds: low-GC notes and `straggler` findings skip stages shorter than 0.5% of the run, the
floor `stageShape` already uses. Every such straggler finding graded info, since a tail can't
cost more than its stage's own duration, and a memory-sizing note from a stage that barely ran
adds nothing. On 14 real logs that drops 464 low-GC notes and 671 straggler findings, all
informational; high-GC, warning and critical findings are unchanged.

Thresholds: `slowHost` and `tinyTask` skip stages shorter than 0.5% of the run too. A slow host or
tiny tasks can't cost more than such a stage's own duration, so every finding there graded info.
On 14 real logs that drops 324 slowHost and 132 tinyTask findings, all informational; warning and
critical findings are unchanged.

Thresholds: `shuffle` and `spill` findings skip stages shorter than 0.5% of the run as well. Their
claims are clipped to the stage, so every such finding graded info. On 14 real logs that drops 182
shuffle and 12 spill findings, all informational; warning and critical findings are unchanged.
