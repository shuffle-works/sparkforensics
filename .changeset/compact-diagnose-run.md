---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics": minor
---

The compact `diagnose_run` view carries only what an agent needs to act. It leaves out `metrics.stages` and `effectiveConf`, which made up most of a response and pushed runs with many stages past the page limit. Each `verdict.steps[].leadFinding` is the finding `id`, not a copy of the row. Pass `include: ["stages"]` or `include: ["effectiveConf"]` to get the blocks back, and `confKeys` to list only named Spark properties in `effectiveConf`. The full view is unchanged.
