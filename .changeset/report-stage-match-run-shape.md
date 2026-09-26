---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics-web": minor
---

The CLI `--stage` filter and MCP `diagnose_run`'s `stageId` now keep a SQL plan finding whose only stage is the one asked for, such as a small-files finding on stage 3, the same rule the dashboard's Stage details uses. The dashboard's filter bar follows the same rule, so its stage filter now agrees with Stage details too.

The evidence report summary and MCP `get_run_summary` gain `runShape`, the run-shape figures the dashboard shows: wall-clock, Efficiency (the share of the run with a stage running), Unused core time, the ETL phases' summed stage time, and the peak busy cores from Core Usage by Locality. Each is null where the dashboard shows "Not measured" or "Unavailable", and the Markdown lists them under the header with what each one measures.

Run from a repository checkout, the CLI, MCP and server entry points no longer silently use a leftover `vendor-core/` built from older core sources. They use it only while it matches `packages/core/src`, and otherwise print a one-line warning and run the current sources. The packed `vendor-core/` now records the hash of the sources it was built from.
