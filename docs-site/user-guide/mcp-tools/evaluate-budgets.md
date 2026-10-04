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
- `regressionBudgets`: further regression budgets, an array of
  `{ "metric": "<key>", "maxPct": <number> }`, the MCP form of the CLI's
  repeated `--regression-budget <metric>:<pct>`. Each is checked like
  `maxRegressionPct` and reports its own `max-regression` result. A metric can
  be budgeted once across this list and the `maxRegressionPct`/`regressionMetric`
  pair (which counts as one budget); a repeat fails the call. Requires
  `runIdB`/`sourceB`, as `maxRegressionPct` does.
- `stageRegressionBudgets`: per paired stage budgets, an array of
  `{ "metric": "<key>", "maxPct": <number> }`, the MCP form of the CLI's
  repeated `--stage-regression-budget <metric>:<pct>`. `metric` is one of
  `executorRunTime`, `executorCpuTime`, `memoryBytesSpilled`,
  `diskBytesSpilled`, `shuffleReadBytes` and `shuffleWriteBytes`. The budget
  fails when any paired stage's metric grew by more than `maxPct`% against its
  baseline stage; growth from a zero baseline always exceeds it. The detail
  names the worst pairs by `pairId` (the same id `compare_runs` returns in
  `stagePairs`). Each metric gets its own `max-stage-regression` result, and a
  metric can be budgeted once. Requires `runIdB`/`sourceB`. It reports
  `inconclusive` when no stage pair is eligible or the metric is missing on
  every eligible pair. `inputBytes` and `outputBytes` are workload volume
  with no regression direction, so the call fails if either is named.
- `stageQualities`: the pair qualities `stageRegressionBudgets` read, from
  `exact`, `structural` and `aligned` (default `exact` and `structural`). An
  `aligned` pair was matched on similarity or position and may compare
  different work, so it is left out unless named. Requires
  `stageRegressionBudgets`. Stages a re-plan left over are not paired and are
  not read.
- `failOnIntroduced`: fail if the second run introduces any finding in the
  given impact band (`"all"` or one of the impact band names). Requires
  `runIdB`/`sourceB`. A band name it doesn't recognize reports `inconclusive`.

A budget whose required evidence is missing (e.g. no `runIdB`/`sourceB` for a
regression budget, or a run with no trustworthy task-level evidence) reports
`inconclusive`, not a false pass. The tool has no `redact` input: the
budgets read figures and impact bands, never the stage text redaction rewrites,
so a redacted comparison gives the same results. Independent of which budgets you pass, an
evaluated run with no ApplicationEnd event adds a `run-complete` result with
status `inconclusive`, the same check that makes the CLI exit `3`. With two
runs, the check applies to the candidate.

Each result's `name` is one of `max-runtime`, `max-spill`, `max-skew`,
`max-failed-task-rate`, `min-efficiency`, `max-regression`,
`max-stage-regression`, `fail-on-introduced` and `run-complete`. A
`max-regression` or `max-stage-regression` result also carries `metric`, the
key it checked. The returned `runId` is the first
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
