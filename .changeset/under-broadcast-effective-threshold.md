---
"@sparkforensics/core": patch
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The missed broadcast join finding (`underBroadcast`) compares the real shuffle `data size` of a join side, the metric adaptive execution uses at runtime, against the threshold the query ran with: `spark.sql.adaptive.autoBroadcastJoinThreshold` when the plan is adaptive and the property is set, else `spark.sql.autoBroadcastJoinThreshold`, with per-query overrides applied. Runs that carried this finding can lose it, so a CI gate or baseline that counted it moves.

- It only names a side the join type can build a broadcast from: the right side for inner, cross, left outer, left semi, left anti and existence joins, the left side for inner, cross and right outer joins, and neither side of a full outer join. The finding carries `joinType` and `buildSide`.
- A side that is not a shuffle of its own (another join's output, an aggregate, a reused exchange) has no measurable size and is not summed from the shuffles beneath it. `largerSideBytes` is absent when the other side has none.
- A smaller side under 1 MiB is skipped (new `broadcastSizing.minSmallerSideBytes` threshold), and the 5 GiB tier is gone: no side above `overBroadcastBytes` (1 GiB) is suggested, so it no longer contradicts the oversized broadcast finding.
- A side at or under the effective threshold fires as `notLimiting` whatever the other side's size, and the advice names the property that governs it.
