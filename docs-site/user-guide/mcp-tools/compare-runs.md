# `compare_runs`

Reference for the `compare_runs` tool of the SparkForensics MCP server.

Compare two runs: the comparison page's verdict, categorized findings delta
and metric deltas. `verdict` is the headline the dashboard's comparison page
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
- `format`: `"json" | "md"` (default `"json"`), switches `content[0].text` to
  a rendered Markdown report instead of JSON. `structuredContent` always
  stays JSON-shaped, regardless of `format`.

Each side needs either a `runId` or a `source`, and you can mix them: a
cached run ID for the baseline, a fresh file for the candidate.

Example call:

```json
{
  "name": "compare_runs",
  "arguments": {
    "sourceA": { "path": "baseline.zstd" },
    "sourceB": { "path": "candidate.zstd" }
  }
}
```

Example response (`metricDeltas` trimmed to its first row of 11):

```json
{
  "runIdA": "aaaa1111-...",
  "runIdB": "bbbb2222-...",
  "verdict": { "title": "The candidate finished 1.0s faster than the baseline (50%)", "tone": "better", "sentences": [] },
  "findingsDelta": { "introduced": [], "resolved": [] },
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
  "confidence": "ok",
  "reason": null,
  "matchedCoverage": 1
}
```

Each `findingsDelta.introduced`/`resolved` row is
`{ rule, type, impactBand, baseCount, candCount, delta, stages }`, with
`stages` naming the affected stages. A `metricDeltas` row's `direction` is
`improvement`, `regression`, `unchanged`, `neutral` (a volume metric, where
more isn't worse) or `unavailable`, and an unavailable row carries an
`unavailableReason`. `confidence` is `low` when the two runs' names differ or
under 50% of stages matched between them (`matchedCoverage`), and `reason`
then says which.
