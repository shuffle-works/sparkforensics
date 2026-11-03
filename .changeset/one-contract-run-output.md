---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

The dashboard, the CLI and MCP take their run output from the same core code. Comparisons and budgets cover the configuration audit findings as well as the detector findings, so a config finding can appear in a comparison's `findings` and be gated by `failOnIntroduced`. The `runShape` block carries `efficiencyFlag` and `unusedCoreTimeFlag` (`critical`, `warning` or `null`), graded as the dashboard Scorecard grades them. The report's `cleanChecks` no longer lists `coreLocality`, which is a figure and not a check, and the dashboard's Clean checks lists the write row-count check as not run when a plain write has no row count, as the report already did.
