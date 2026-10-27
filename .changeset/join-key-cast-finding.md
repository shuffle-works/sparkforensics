---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

A new `joinKeyCast` finding (tag `PLAN`, informational) flags a sort-merge or shuffled hash join whose key carries a cast, such as a decimal column joined to a bigint column, when an exchange after the join shuffles by the uncast column again. The join output is partitioned by the cast expression, so the next operator cannot reuse it. The finding names the join, its cast keys and that exchange, and its value is the exchange's data size. The advice is to give both join columns the same type before the join. Exchange keys that hold a comma, such as `cast(k as decimal(20,0))`, are now parsed whole in the plan summary.
