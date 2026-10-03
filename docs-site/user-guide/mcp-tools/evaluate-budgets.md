# `evaluate_budgets`

Reference for the `evaluate_budgets` tool of the SparkForensics MCP server.

Evaluate a run against pass/fail thresholds: the MCP equivalent of the CLI's
`--max-runtime`/`--max-spill`/etc. budget flags, thin-wrapped over the same
`evaluateBudgets()` the `sparkforensics-analyze` CLI uses.

Parameters (all optional):

- `source` / `runId`: identify the run to evaluate (same shape as
  `diagnose_run`). When `runIdB`/`sourceB` is also given, this run is the
  regression baseline instead.
- `maxRuntimeMs`, `maxSpillGb`, `maxSkewRatio`, `maxFailedTaskRatePct`,
  `minEfficiencyPct`: absolute budgets, each evaluated only if provided. With
  two runs they apply to the candidate (`runIdB`/`sourceB`), the same as the
  CLI's `--baseline` mode. `minEfficiencyPct` measures busy core time, the
  share of executor core time that ran tasks (100 minus the dashboard's
  Unused core time), not the dashboard's Efficiency tile. `maxFailedTaskRatePct`
  reads the task failure rate off the `jobFailureRate` finding, so when that
  finding didn't fire (under 10% of jobs failed, by default) it passes whatever
  the task failure rate.
- `runIdB` / `sourceB`: a candidate run to compare against the first, so
  regression budgets can be evaluated. Same `runId`/`source` shape, resolved
  the same way. Omit both to skip regression budgets.
- `maxRegressionPct`, `regressionMetric`: fail if `regressionMetric` (default
  `wallClock`; see [Regression metric keys](../getting-started/regression-metric-keys.md#regression-metric-keys)
  for the full list) regressed by more than `maxRegressionPct`% between the
  first run (baseline) and the second run (candidate). Requires
  `runIdB`/`sourceB`. `regressionMetric` without `maxRegressionPct` fails the
  call. A volume key (`inputBytes`, `outputBytes`, `taskCount`,
  `executorsAdded`), which has no regression direction, or an unknown key
  reports `inconclusive`.
- `failOnIntroduced`: fail if the second run introduces any finding in the
  given impact band (`"all"` or one of the impact band names). Requires
  `runIdB`/`sourceB`. A band name it doesn't recognize reports `inconclusive`.

A budget whose required evidence is missing (e.g. no `runIdB`/`sourceB` for a
regression budget, or a run with no trustworthy task-level evidence) reports
`inconclusive`, not a false pass. Independent of which budgets you pass, an
evaluated run with no ApplicationEnd event adds a `run-complete` result with
status `inconclusive`, the same check that makes the CLI exit `3`. With two
runs, the check applies to the candidate.

Each result's `name` is one of `max-runtime`, `max-spill`, `max-skew`,
`max-failed-task-rate`, `min-efficiency`, `max-regression`,
`fail-on-introduced` and `run-complete`. A `max-regression` result also
carries `metric`, the key it checked. The returned `runId` is the first
run's (the baseline, when two runs are given).

Example call:

```json
{
  "name": "evaluate_budgets",
  "arguments": {
    "source": { "path": "baseline.zstd" },
    "sourceB": { "path": "candidate.zstd" },
    "maxRegressionPct": 10,
    "failOnIntroduced": "critical"
  }
}
```

Example response:

```json
{
  "runId": "aaaa1111-...",
  "results": [
    {
      "name": "max-regression",
      "metric": "wallClock",
      "status": "violation",
      "detail": "Metric \"wallClock\" regressed 100.0%, exceeding budget 10%."
    },
    {
      "name": "fail-on-introduced",
      "status": "pass",
      "detail": "No introduced findings match \"critical\"."
    }
  ],
  "violated": true,
  "inconclusive": false
}
```
