# `compare_runs`

Reference for the `compare_runs` tool of the SparkForensics MCP server.

Compare two runs: the comparison page's verdict, metric deltas (`metrics`) and
categorized findings delta (`findings`), and the share of executor run time in
paired stages (`runtimeCoverage`). The result
carries the same `verdict`, `confidence`, `reason`, `matchedCoverage`,
`runtimeCoverage`, `metrics`, `findings`, `comparisonSchemaVersion`,
`unmatched`, `replanned`, `bookkeepingStageIds` and `executionAlignment` as the
`comparison` object of the CLI's `--baseline` JSON output, plus `stagePairs`
when `include` asks for it (the CLI always carries it), plus
`runIdA` and `runIdB`. `metricDeltas` and `findingsDelta` repeat `metrics` and
`findings` under their earlier names; they are deprecated and will be removed
in a later release. `verdict` is the headline the dashboard's comparison page
opens with (the baseline is `runIdA`/`sourceA`, the candidate `runIdB`/`sourceB`): a
`title` such as "The candidate finished 9.9s faster than the baseline (37%)", or a failed-job
headline when either run had jobs fail, a `tone` (`better`, `worse`, `same` or
`unknown`), and `sentences` naming which cost metrics and finding categories
moved each way. When either log has no `ApplicationEnd` event, the title
compares how much run time each log covers ("The candidate's log covers 2.0s less run
time than the baseline's") and the tone is `unknown`.

Parameters:

- `runIdA` / `sourceA`: identify the baseline (same `source` shape as above)
- `runIdB` / `sourceB`: identify the candidate
- `redact`: `boolean` (default `false`), pseudonymizes any app id or host/IP
  tokens embedded in free text (stage names and similar) in the response: see
  the note at the top of this page
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
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

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
      "direction": "improvement"
    }
  ],
  "findings": { "introduced": [], "resolved": [] },
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
      "direction": "improvement"
    }
  ],
  "findingsDelta": { "introduced": [], "resolved": [] }
}
```

Each `findings.introduced`/`resolved` row is
`{ rule, type, impactBand, baseCount, candCount, delta, stages }`, with
`stages` naming the affected stages. A `metrics` row's `direction` is
`improvement`, `regression`, `unchanged`, `neutral` (a volume metric, where
more isn't worse) or `unavailable`, and an unavailable row carries an
`unavailableReason`.

The comparison block (`comparisonSchemaVersion` `1`) holds:

- `stagePairs` (only with `include`): one entry per pair of stages, `pairId` (stable for one pair of
  runs; key on it), `baseStageIds` and `candStageIds`, `quality` (`exact`,
  `structural` or `aligned`), `score` (0 to 1) and `deltas`. `deltas` has one
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
  outside the Delta bookkeeping set), `pairedExecutions`, `agreement` (`2 *
  pairedExecutions / (baseExecutions + candExecutions)`, `null` when either run
  has none), `accepted` (false when `agreement` is under 0.5: the runs share too
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
