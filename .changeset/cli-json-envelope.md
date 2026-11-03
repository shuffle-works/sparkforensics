---
"sparkforensics-cli": minor
---

The CLI's JSON output has one shape in every mode: `{ schemaVersion, run, comparison?, budgets }`. Before, the top level changed with `--baseline` (the run's report alone, or `{ candidate, comparison }`) and a single run's budget results went only to stderr. Now `run` is the report, `comparison` is present with `--baseline`, and `budgets` lists every budget result, passes included. Each `--format ndjson` line is `{ log, status, exitCode, error }` plus the same keys, with `run` in place of `candidate`. Stderr keeps the human summary of failed budgets. The schema is `schema/cli-envelope.schema.json` in the package. To read the earlier shapes for one more release, pass `--legacy-json`; it is removed in 0.13.0, so read `run` and `comparison` from the envelope instead.
