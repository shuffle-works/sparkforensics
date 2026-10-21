---
'sparkforensics-cli': patch
'sparkforensics-mcp': patch
---

The `max-failed-task-rate`, `max-spill` and `max-skew` budgets measure the run directly. The failed-task rate is the sum of failed tasks over the sum of tasks across all stages, so retried task failures fail the budget even when every job succeeded. Peak spill is the largest per-stage memory spill, so a short stage the spill finding hides still counts. Skew ignores stages with no task-duration median instead of reporting a `NaN` peak, and a run with no usable figure is `inconclusive` rather than `pass`.
