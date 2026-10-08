---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Attribute a slow task tail to its cause. Each stage's tail (non-failed tasks over 3x the median task) is attributed from per-task input and shuffle-read bytes and records, GC time, shuffle fetch wait, CPU time and host. `skew` now fires on a tail whose extra time follows data volume, and `straggler` fires on the rest with the cause named (GC, shuffle fetch wait, one slow host, or unexplained with CPU use), so one tail is no longer reported by both. With no data volume to compare, the part of the tail that data, GC, fetch wait and host do not explain is `unattributed` when it is the largest share, and both detectors keep the duration-only behaviour for it, as for a stage with no tail attribution. New evidence fields: `cause` and `dataRatio` on `skew`; `cause`, `causeSharePct`, `host`, `hostTasks` and `cpuPct` on `straggler`. New `skew` threshold `dataShareMin`; `straggler` judges a tail with `skew`'s `ratioWarn`, `minTasksForP95`, `dataShareMin` and `floorPctWarn`, so tuning `skew` alone never leaves a tail reported by neither.
