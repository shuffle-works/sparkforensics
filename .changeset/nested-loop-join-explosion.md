---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

A new `nestedLoopJoin` plan finding flags a `BroadcastNestedLoopJoin` or `CartesianProduct` whose output rows explode. Spark plans these when a join has no equi-join key, and they compare every left row with every right row. The finding fires when the join's executor-side `number of output rows` is at least 1,000,000 and, for a `BroadcastNestedLoopJoin`, at least 10 times its larger input; a `CartesianProduct` re-reads each input once per partition of the other side, so it is judged on its output alone. It carries the join type and condition, the output and input row counts, and an impact graded by the time of the stages that run the join. The advice is to add an equi-join key, to bucket the range of a range join, or to confirm that a cross join is intended. A join with no reported row counts is not flagged. The public corpus has no nested-loop join, so its findings do not change.
