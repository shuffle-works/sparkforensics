---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Unused core time now counts executor capacity as the most cores alive at once, the count the idle-capacity findings already use. It used to add up every executor the run ever added, so on a run that replaced executors (spot preemption, dynamic allocation) the Scorecard tile read higher than the verdict's idle figure: 88% beside 75% on a run that swapped one executor for another midway. The same capacity now feeds Compute Efficiency, Wasted Core-Hours, the report's `runShape.unusedCoreTimePct` and the `--min-efficiency` budget, so those figures drop on such runs and a budget that failed on the old count can pass. Runs whose executors never left are unchanged. The tile's Basic view caption now says what it measures instead of explaining a gap that no longer exists.
