---
'sparkforensics-cli': minor
---

A Spark History Server run can be the comparison baseline: `--baseline-shs-base-url`, `--baseline-app-id` and `--baseline-attempt-id` mirror the candidate flags, are mutually exclusive with `--baseline <path>`, and work with every flag that needs a baseline. Several candidates can come from one History Server by repeating `--app-id` (`--app-id <id>:<attempt>` names an attempt), with NDJSON output as for several local logs.
