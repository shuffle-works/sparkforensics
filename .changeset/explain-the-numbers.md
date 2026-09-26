---
"sparkforensics-web": minor
---

The scorecard now explains itself: Wall-clock, Efficiency and Unused core time (renamed from Wastage)
each say in Basic view what they measure and whether higher or lower is better, so a high
Efficiency next to a high Unused core time no longer reads as a contradiction. Advanced view keeps the
raw run and idle-time breakdown. Stage pills read "Stage 7" instead of "S 7". The verdict adds a
collapsed "New to Spark tuning?" primer on stages, tasks, executors, shuffle, savings and impact
colors, with a link to the finding guide; Advanced view hides it.

On phones, finding rows now put the stage and savings on their own line under the recommendation
instead of cutting them off at the screen edge.
