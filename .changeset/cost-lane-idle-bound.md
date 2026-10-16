---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

The verdict adds a cost lane beside its wall-clock steps and states the run's idle capacity. `verdict.costSteps` ranks findings by the measured busy core time a fix removes (`impactEstimate.coreTimeMs`), including findings with no wall-clock claim; a finding with no core-time figure is in neither lane. `verdict.idle` (`{ coreHours, allocatedCoreHours, pct, text }`) reads, for example, "14.8 core-h (22%) of the allocation ran no task." The dashboard labels the two lanes "By wall clock" and "By core time". The report schema stays 5; the fields are additive.

The stage-shape `taskStageSkew` idle figure is a modeled upper bound that assumes every executor stays allocated through the straggler tail. It is now labeled `modeled` and clipped to the run's idle core time, so one stage never reports more idle capacity than the whole run.
