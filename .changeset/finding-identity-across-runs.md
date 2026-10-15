---
"@sparkforensics/core": minor
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Run comparison matches findings across runs by identity instead of tallying them by rule and impact band. A finding is the same finding in both runs when it has the same type, rule and location (a paired stage, a paired SQL execution, an audited setting, or the whole run), whatever its value or impact band. A finding that moves between bands, such as critical to warning, is no longer reported as one resolved plus one introduced, so `--fail-on-introduced` and the comparison verdict no longer treat an improved run as worse.

Output changes in the CLI `comparison` block, the MCP `compare_runs` result (including its deprecated `findingsDelta` alias) and the dashboard:

- `findings.changed` is new: one row per rule and band move, `{ rule, type, baseImpactBand, candImpactBand, count, stages }`.
- `findings.introduced` and `findings.resolved` rows now hold only findings with no counterpart in the other run. An introduced row has `baseCount` 0 and a resolved row has `candCount` 0; a rule with more findings in the candidate no longer reads `1 -> 2`.
- A finding that moves to a stage or SQL execution that pairs with a different one reads as resolved plus introduced.
- The `--fail-on-introduced` budget and the MCP `evaluate_budgets` `failOnIntroduced` budget read the same diff, so a re-banded finding no longer violates them. A finding that rises to a gated band is `changed`, not introduced.
- The Markdown comparison report has a `### Changed findings` section.
- The dashboard comparison page lists band moves under "Impact changed in candidate".
