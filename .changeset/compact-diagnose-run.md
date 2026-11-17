---
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics": minor
---

The compact `diagnose_run` view carries only what an agent needs to act. It leaves out `metrics.stages` and `effectiveConf`, which made up most of a response and pushed runs with many stages past the page limit. Its `verdict.steps[]` leave out `leadFinding`, a copy of a row `findings` already lists: `leadFindingId` names the lead. Pass `include: ["stages"]` or `include: ["effectiveConf"]` to get the blocks back, or `confKeys` to get `effectiveConf` with only the named Spark properties. The full view is unchanged.
