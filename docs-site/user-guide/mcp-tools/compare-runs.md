# `compare_runs`

Reference for the `compare_runs` tool of the SparkForensics MCP server.

Compare two runs: the comparison page's verdict, metric deltas (`metrics`) and
categorized findings delta (`findings`), and the share of executor run time in
paired stages (`runtimeCoverage`). The result
carries the same `generator` (the `sparkforensics-mcp` build that wrote the result),
`verdict`, `baselineApp` and `candidateApp` (each run's Spark application `id` and
`attemptId`), `confidence`, `reason`, `matchedCoverage`,
`runtimeCoverage`, `metrics`, `findings`, `comparisonSchemaVersion`,
`unmatched`, `replanned`, `bookkeepingStageIds`, `executionAlignment` and `comparability` as the
`comparison` object of the CLI's `--baseline` JSON output, plus `stagePairs`
when `include` asks for it (the CLI always carries it), plus
`runIdA` and `runIdB`, which are handles for the runs this server process has
cached and differ per tool by design: match runs by `baselineApp` and `candidateApp`.
Each row of `findings` lists its stage names in `stages` and the same names with the
directories of their call-site paths removed in `stageLabels`; each `stagePairs` row has
the same kind of label in `stageLabel`. The raw names in `stages` still carry those paths,
and `redact` does not remove them, so show `stageLabels` and `stageLabel`.
`metricDeltas` and `findingsDelta` repeat `metrics` and
`findings` under their earlier names; they are deprecated and will be removed
in a later release. `verdict` is the headline the dashboard's comparison page
opens with (the baseline is `runIdA`/`sourceA`, the candidate `runIdB`/`sourceB`): a
`title` such as "The candidate finished 9.9s faster than the baseline (37%)", or a failed-job
headline when either run had jobs fail, a `tone` (`better`, `worse`, `same`, `unknown`, `equivalent` or `mixed`), and `sentences` naming which cost metrics and finding categories
moved each way. When either log has no `ApplicationEnd` event, the title
compares how much run time each log covers ("The candidate's log covers 2.0s less run
time than the baseline's") and the tone is `unknown`.

Parameters:

- `runIdA` / `sourceA`: identify the baseline (`source` has the shape in
  [Common parameters](../mcp-tools.md#common-parameters); [Run roles](../mcp-tools.md#run-roles) compares the baseline and candidate across surfaces)
- `runIdB` / `sourceB`: identify the candidate
- `redact`: `boolean` (default `false`), pseudonymizes any app id, host name
  or user name embedded in free text (stage names and similar) in the
  response: see the note at the top of this page and [What `--redact` covers](../getting-started/ci-and-automation.md#what-redact-covers)
- `include`: `["stagePairs"]` (optional), adds `stagePairs`, one row per paired
  stage. It is left out by default because it grows with the number of stages.
- `normalizePath`: `string[]` (optional), regular expressions whose every match
  in a plan node's text is replaced with a fixed token before stages are
  paired, so text that is specific to your runs does not keep the same stage
  from pairing. Despite the name it is a generic pattern, not only for paths.
  It affects stage pairing, `runtimeCoverage` and `confidence`, never the
  findings. At most 16 patterns of 200 characters each. An invalid pattern, or
  one that matches the empty string, fails the call before any log is read. A
  pattern that backtracks catastrophically can stall the server, and the length
  cap does not prevent that: an agent passing patterns should keep them simple
  and anchored.
- `ignoreConf`: `string[]` (optional), regular expressions matched against
  Spark configuration keys. A key that matches one is left out of
  `comparability.conf`, for keys that differ by design such as a per-run output
  path. Same limits as `normalizePath`; an invalid pattern fails the call before
  any log is read.
- `noiseBand`: `number` from 0 to 1 (optional, default `0.02`), the share of the
  baseline value under which a metric row is `withinNoise`. It never changes a
  row's `direction`.
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

`comparability` says whether the two runs can be read against each other:

- `conf`: `equal` (`true` when `differences` is empty after the ignore list;
  `null` when a log records no Spark properties), `differences` (rows of `key`,
  `baseline` and `candidate`, a side that does not set the key is `null`),
  `ignoredKeys` (keys that differ but are left out: per-run identity keys and
  the `ignoreConf` matches) and `withheldKeys` (secrets, never compared or
  shown). Values come from the same builder as the run report's `effectiveConf`,
  so a key withheld there is withheld here, including the CLI's `--conf-redact-regex` matches.
- `plan`: `equal`, `unmatched` (stage counts per side) and `replanned` (groups).
- `volume`: `inputBytes`, `outputRows` and `outputBytes`, each with `baseline`,
  `candidate` and `relativeDifference`, and `equal`: output rows equal, input
  and output bytes within the noise band. `equal` is `null` unless output rows or
  output bytes are measured on both sides; input bytes alone never make it `true`.
- `capacity`: mean and peak executors per side.
- `overlapMs`: how long the two run windows overlap.
- `wallClockBridge`: `wallClock`, `taskTime`, `meanExecutors` and
  `taskShareOfAllocation`, each with `baseline`, `candidate` and `ratio`, and
  `explainedWallClock`, the task-time ratio over the product of the other two.
- `noiseBand`: the band in use.

The `verdict` tone is `equivalent` when `conf.equal`, `plan.equal` and
`volume.equal` are all `true` and either the wall-clock gap is within the noise
band or a bridge factor (mean executors, task time or task share of allocation)
moved past it and explains the gap. When configuration and plan agree but the gap
is past noise and no factor explains it, the tone stays `better` or `worse` from the
wall clock and the title ends "no measured factor explains it". When `volume.equal`
is `null`, the tone also comes from the wall clock and the title reads "Same
configuration and plan. Output was not compared." The tone is `mixed` when the
wall clock and executor run-time or allocated core-hours move opposite ways past the
noise band and the configuration or plan differs. A failed job or an incomplete log
still leads the verdict.

Each side needs either a `runId` or a `source`, and you can mix them: a
cached run ID for the baseline, a fresh file for the candidate.

Example call (add `"include": ["stagePairs"]` to the arguments for the pair rows):

```json
{
  "name": "compare_runs",
  "arguments": {
    "sourceA": { "path": "baseline.zstd" },
    "sourceB": { "path": "candidate.zstd" }
  }
}
```

Example response with `include: ["stagePairs"]` (`metrics` and `metricDeltas` trimmed to their first row of 13, and each pair's `deltas` to three of its eight metrics):

```json
{
  "runIdA": "aaaa1111-...",
  "runIdB": "bbbb2222-...",
  "generator": { "name": "sparkforensics-mcp", "version": "0.9.0", "buildId": "9c1f3a7e2b4d" },
  "baselineApp": { "id": "application_0000000000000_0001", "attemptId": null },
  "candidateApp": { "id": "application_0000000000000_0002", "attemptId": null },
  "verdict": { "title": "The candidate finished 1.0s faster than the baseline (50%)", "tone": "better", "sentences": [] },
  "confidence": "ok",
  "reason": null,
  "matchedCoverage": 1,
  "runtimeCoverage": 1,
  "metrics": [
    {
      "key": "wallClock",
      "label": "Wall-clock duration",
      "baseline": 2000,
      "candidate": 1000,
      "delta": -1000,
      "direction": "improvement",
      "withinNoise": false
    }
  ],
  "findings": { "introduced": [], "resolved": [], "changed": [] },
  "comparisonSchemaVersion": 1,
  "stagePairs": [
    {
      "pairId": "b0-c0",
      "baseStageIds": [0],
      "candStageIds": [0],
      "quality": "exact",
      "score": 1,
      "deltas": {
        "executorRunTime": { "baseline": 1800, "candidate": 900, "delta": -900 },
        "executorCpuTime": { "baseline": null, "candidate": null, "delta": null },
        "memoryBytesSpilled": { "baseline": 0, "candidate": 0, "delta": 0 }
      }
    }
  ],
  "unmatched": { "baseStageIds": [], "candStageIds": [] },
  "replanned": [],
  "bookkeepingStageIds": { "baseStageIds": [], "candStageIds": [] },
  "executionAlignment": { "baseExecutions": 1, "candExecutions": 1, "pairedExecutions": 1, "bounded": false, "agreement": 1, "accepted": true },
  "metricDeltas": [
    {
      "key": "wallClock",
      "label": "Wall-clock duration",
      "baseline": 2000,
      "candidate": 1000,
      "delta": -1000,
      "direction": "improvement",
      "withinNoise": false
    }
  ],
  "findingsDelta": { "introduced": [], "resolved": [], "changed": [] }
}
```

A finding is the same finding in both runs when it has the same type, rule and location (a
paired stage, a paired SQL execution, an audited setting, or the whole run), whatever its
value or impact band. Each `findings.introduced`/`resolved` row groups the findings of one
rule and band that have no counterpart in the other run: `{ rule, type, impactBand,
baseCount, candCount, delta, stages, keys }`, with `baseCount` 0 on an introduced row, `candCount`
0 on a resolved row, and `stages` naming the stages the findings sit on. `keys` lists the `key` of
each finding the row counts, as [`diagnose_run`](./diagnose-run.md) reports it for the run the
findings are in (the candidate for an introduced row, the baseline for a resolved one), so a row
points at the findings it counts. Each
`findings.changed` row groups the findings both runs have whose impact band differs:
`{ rule, type, baseImpactBand, candImpactBand, count, stages, keys, baseKeys }`, with `stages` naming the
candidate's stages, `keys` the candidate's finding keys and `baseKeys` the baseline's. The two
differ when the aligner paired stages that do not share a fingerprint. A `metrics` row's `direction` is
`improvement`, `regression`, `unchanged`, `neutral` (a volume metric, where
more isn't worse) or `unavailable`, and an unavailable row carries an
`unavailableReason`.

The comparison block (`comparisonSchemaVersion` `1`) holds:

- `stagePairs` (only with `include`): one entry per pair of stages, `pairId` (stable for one pair of
  runs; key on it), `baseStageIds` and `candStageIds`, `stageLabel` (the pair's
  baseline stage name with call-site directories removed; the row has no raw name),
  `quality` (`exact`, `structural` or `aligned`), `score` (0 to 1) and `deltas`. `deltas` has one
  `{ baseline, candidate, delta }` entry for each of `executorRunTime`,
  `executorCpuTime` (ms), `memoryBytesSpilled`, `diskBytesSpilled`,
  `inputBytes`, `outputBytes`, `shuffleReadBytes` and `shuffleWriteBytes`. The
  figures count every task attempt of the stage, failed ones included, the
  same sums the whole-run `metrics` use; a figure the log did not record is
  `null`. A stage's own record in the run report keeps the latest attempt's
  figures.
- `unmatched`: `{ baseStageIds, candStageIds }`, the stages that paired with
  nothing and sit in no replanned group.
- `replanned`: one group for each aligned pair of SQL executions whose stage
  counts differ and that left stages unpaired (a broadcast join that took out an
  exchange, for example). A group holds `baseExecutionId`, `candExecutionId`,
  `baseStageIds` and `candStageIds` (the leftover stages per side) and `deltas`,
  the total of each of the eight delta metrics over the leftover stages of each
  side, as `{ baseline, candidate, delta }` entries like a pair's. Leftover
  stages under an execution pair with equal stage counts are `unmatched`.
- `bookkeepingStageIds`: `{ baseStageIds, candStageIds }`, stages that only read
  the Delta log or its checkpoints. They are in no pair, not in `unmatched` and
  not in the coverage.
- `runtimeCoverage`: the share of both runs' executor run time (bookkeeping
  stages excluded) in paired and replanned stages, or `null` when neither run
  recorded any.
- `executionAlignment`: how the SQL executions of the two runs lined up:
  `baseExecutions` and `candExecutions` (executions with at least one stage
  outside the Delta bookkeeping set), `pairedExecutions`, `agreement` (`pairedExecutions
  / min(baseExecutions, candExecutions)`, `null` when either run has none), `accepted` (false when `agreement` is under 0.5: the runs share too
  little SQL work to be one job, and no stage pairs) and `bounded` (true when
  the alignment ran in its band form, which happens above 1,000,000 execution
  pairs).
- `matchedCoverage`: the share of stages paired by the exact key alone, by
  count.

A pair's `quality` is `exact` (same normalized name and plan text), `structural`
(same plan shape and attribute names, different text) or `aligned` (different
structure with similar text, or no plan to compare and paired by position among
stages of one name). `score` is 1 for `exact`, the text similarity for the other
two, and 0.5 for a pair made by position. See [How stages are matched](../run-comparison/how-stages-are-matched.md).

`confidence` is `ok`, `low` or `insufficient`, and `reason` says why when it
is not `ok`. It is `low` when the two runs' names differ, or when under 90% of
executor run time is in paired stages (`runtimeCoverage`), for example "Only
62% of executor run time is in matched stages". It is `insufficient` when
neither run recorded any executor run time.
