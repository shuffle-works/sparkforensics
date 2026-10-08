---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Plan operators now carry the SQL metric values that executors report, the figures Spark's SQL tab shows. They are read from the accumulables of each `SparkListenerStageCompleted` event, where a plan metric's value is its running total, so a later stage replaces an earlier one's value. A value from the driver's own accumulator updates still wins when both exist. Exchange `data size`, operator `peak memory`, `spill size`, `number of output rows` on joins and scans, `data sent to Python workers` and the operator timing metrics resolve to real values; `average` metrics are left out, because their total is not the average the SQL tab computes.

- `underBroadcast` compares Exchange data sizes that are now populated, so it fires on sort-merge joins with a small side where it previously saw `0 KB` on both. Its logic is unchanged. The corpus gains 29 `underBroadcast` findings, all `info` band.
- Plan-shape fingerprints skip executor-side metrics, so `duplicatePlanSubtree` and `cachingOpportunity` ids are unchanged.
- The plan view shows the new values, and its per-operator time attribution weights operators by their timing metrics where it used to split stage time evenly.
