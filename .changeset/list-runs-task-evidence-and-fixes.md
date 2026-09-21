---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Add the `list_runs` MCP tool, which finds candidate Spark runs in a local
directory or on a Spark History Server (by name pattern, date range, capped
count) before diagnosing one with the other tools.

`stageFailed` and `retryWaste` findings now carry up to 20 sampled
failed/retried tasks each (task id, attempt number, host, executor, failure
reason, peak executor memory, spill, shuffle write), instead of only a
stage-level count. Redaction now walks every field literally named `host`
anywhere in the findings tree, so these new samples get host-redacted too.

Fix `compare_runs` stage matching under-reporting coverage: identities that
collide the same number of times on both runs now pair off positionally
instead of being dropped as ambiguous, and a stage's SQL identity is scoped
to only the plan nodes that stage actually ran instead of the whole plan
tree. Together these recover matched coverage on self-comparisons and on
comparisons involving repeated stage shapes (e.g. a self-join's two Exchange
stages).

Rework the recommendation copy for slow-host and straggler findings so it no
longer presumes a hardware fault by default, pointing at data locality and
`spark.speculation` instead. Stage-slowness recommendation copy now points
at shuffle-partition tuning. Fix the plan-node-detail parser so operators
with no dedicated branch (e.g. `InMemoryTableScan`) no longer repeat their
own name as a duplicate prefix in the parsed detail text.
