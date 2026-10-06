---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Four additive changes to the CLI JSON report and MCP `diagnose_run`. The report's `schemaVersion` is unchanged.

- The CLI JSON report carries a `generator` block, `{ name, version, buildId }`, naming the CLI package and the core build that wrote it. MCP `diagnose_run` does not return it, because the MCP server has no real package version to report yet.
- `metrics.allocation` adds `dynamicAllocation` (`on` or `off` when the log records `spark.dynamicAllocation.enabled`, else `null`), `executorsPeak`, `executorsMean` (executor seconds over application start to close), `executorCores` (`null` when unknown or mixed) and `executorSeconds`. The executor figures are `null` when the log has no executor events. The `coldStart` and `autoscalingChurn` evidence is unchanged.
- `writeTargets.writes[]` adds `mergeRows`, `{ inserted, updated, deleted, copied }`, read from a `MergeIntoCommand` node's SQL metrics. `outputRows` is unchanged. It is `null` for other commands and for `DeltaMerge` rows, the API merges that run no command node, so those still report no row counts.
- The `Remediation` union is widened. Besides `{ kind: 'conf', key, direction, suggested }`, an entry can be `{ kind: 'code', hint }`: a fix no Spark property makes. Skew, straggler and partition-skew findings carry one when `evidence.origin` is `other` or AQE skew-join handling is already on, where `remediation` was empty. A consumer that reads `key` on every entry must check `kind` first.
