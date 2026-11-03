---
"sparkforensics-cli": minor
---

The CLI's JSON output has one shape in every mode: `{ schemaVersion, run, comparison?, budgets }`. The top level no longer changes with `--baseline`, and there is no flag to keep the earlier shapes. Read `run` where you read `candidate` or the top-level report, and `comparison` as before. `budgets` lists every budget result, passes included. Each `--format ndjson` line is `{ log, status, exitCode, error }` plus the same keys. Stderr keeps the human summary of failed budgets. The schema is `schema/cli-envelope.schema.json` in the package. `--legacy-json` is removed and exits 2 as an unknown option.
