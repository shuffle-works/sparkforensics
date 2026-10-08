---
"@sparkforensics/core": minor
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

The missed broadcast join finding (`underBroadcast`) compares the real shuffle `data size` of a join side, the metric adaptive execution uses at runtime, against the threshold the query ran with: `spark.sql.adaptive.autoBroadcastJoinThreshold` when the plan is adaptive and the property is set, else `spark.sql.autoBroadcastJoinThreshold`, with per-query overrides applied. Runs that carried this finding can lose it, so a CI gate or baseline that counted it moves.

- It only names a side the join type can build a broadcast from: the right side for inner, cross, left outer, left semi, left anti and existence joins, the left side for inner, cross and right outer joins, and neither side of a full outer join. The finding carries `joinType`, `buildSide` and `buildSideBytes`; a join whose only buildable side is larger than the other side is skipped, since broadcasting it saves nothing.
- Both join sides need a shuffle size of their own. A side that is not a shuffle of its own (another join's output, an aggregate, a reused exchange) is not summed from the shuffles beneath it, and its join is skipped, so `largerSideBytes` is always present.
- A smaller side under 1 MiB is skipped (new `broadcastSizing.minSmallerSideBytes` threshold), and the 5 GiB tier is gone: no side above `overBroadcastBytes` (1 GiB) is suggested, so it no longer contradicts the oversized broadcast finding. Breaking for custom thresholds files: `broadcastSizing.broadcastTiers` now has 3 entries and `comparisonTiers` 2, so a file that sets either must drop its largest tier or it is rejected.
- A side at or under the effective threshold fires as `notLimiting` whatever the other side's size, and the advice names the property that governs it.
- The oversized broadcast finding (`overBroadcast`) also checks `spark.sql.adaptive.autoBroadcastJoinThreshold` under adaptive execution: it blames a `broadcast()` hint only when every applicable threshold is below the broadcast, reports auto-broadcast disabled only when all are, and otherwise names the property that admitted it.
