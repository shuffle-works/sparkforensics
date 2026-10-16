---
"@sparkforensics/core": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

Delta DataFrame writes now report `outputRows` in `writeTargets`. The write node (`SaveIntoDataSourceCommand`) has no row metric, so the figure is the sum of `outputRecords` over the stages of the write's root execution, where the rows are written. The same sum fills the new `outputBytes`. The new `outputRowsSource` (`nodeMetric` or `stageSum`) says which one a figure is, so a comparison can require both sides to match. The sum applies to plain writes only (never MERGE, UPDATE, DELETE or table maintenance) and only when the root execution holds one logical write. A plain write that still has no figure is listed in `notRunChecks` as `writeOutputRows`. Report schema 5 and metrics schema 1 are unchanged; the fields are additive.
