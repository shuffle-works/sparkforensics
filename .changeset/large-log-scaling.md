---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Analysis of very large logs (tens of thousands of stages, millions of tasks) scales linearly where it was quadratic, and no longer throws on a 150k-stage run. Finding de-duplication, SQL-execution stage lookup, merge-write overlap detection, executor-removal cache cleanup and wide plan-tree parsing each avoid a scan per item, per-task core usage is computed from typed arrays, and `computeRunMetrics` and the budget checks no longer spread a per-stage array into `Math.max`. The dashboard prefetches task data in one store update, groups findings by stage once, memoizes the timeline and builds a plan tree only when its section opens. Findings and estimates are unchanged.
