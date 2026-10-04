---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
"sparkforensics-web": minor
---

Stages now pair in two levels, and the stages a re-plan leaves over are reported as `replanned` instead of `unmatched`.

SQL executions of the two runs align first, in submission order, scored on call site, description and plan structure. Then the stages inside each aligned pair of executions pair as `exact` (same normalized name and plan text), `structural` (same plan shape and sorted attribute names, with literals, paths, file counts and ids left out) or `aligned` (similar text, or no plan to compare and paired by position among stages of one name). A loop that ran 14 times in one run and 15 in the other pairs 14 iterations, a self-join subtree counted 3 times against 2 pairs 2, and a grouping set emitted in another column order each run pairs structurally. The `structural` and `aligned` qualities were reserved values before; `score` is 1 for `exact`, the text similarity for the other two, and 0.5 for a pair made by position.

When an aligned execution pair has different stage counts (a broadcast join took out an exchange) and stages are left over, they are reported once in `replanned`: `baseExecutionId`, `candExecutionId`, `baseStageIds`, `candStageIds` and `deltas` (the total of each delta metric per side). Leftovers under equal stage counts stay `unmatched`.

**Behaviour change: `runtimeCoverage` and `confidence` count replanned run time.** `runtimeCoverage` is the share of both runs' executor run time in paired and replanned stages, so a conf change that re-plans a join can report `ok`. `replanned` carries the totals so a caller can see how much run time that is. Runs whose SQL executions share too little work to be one job (fewer than half of all executions pair) get no stage pairs at all, so a comparison of two different jobs reports `low` instead of pairing generic stages such as a lone `count`.

New field `executionAlignment` in the comparison block (`baseExecutions`, `candExecutions`, `pairedExecutions`, `agreement`, `accepted`, `bounded`), in the CLI's `comparison` object, MCP `compare_runs` and the dashboard's result. The execution alignment runs in full up to 1,000,000 execution pairs and in a band around the diagonal above that; `bounded` says which. `comparisonSchemaVersion` stays 1: the change is additive.
