---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The CLI and the MCP tools reject malformed input instead of passing silently. The budget flags and `--stage` take plain non-negative decimals (an empty, negative, hexadecimal or exponent value exits 2), `--impact`, `--type` and `--fail-on-introduced` accept only known bands and finding types (exit 2, not an empty findings list or exit 3), and the MCP schemas constrain numeric budgets, `stageId`, `impactBand`, `type`, `regressionMetric`, `regressionBudgets` metrics and `failOnIntroduced`.
