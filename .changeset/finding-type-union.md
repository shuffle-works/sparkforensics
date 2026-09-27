---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

Evidence report schema 5 (CLI JSON, MCP `diagnose_run` and `get_finding_evidence`). A finding row's `evidence` now holds only the fields its finding type declares as evidence, so fields detectors kept for the impact estimator no longer appear: `stageShape`'s `totalCores`; `utilization`'s `utilizationFraction`, `appDurationMs` and `totalCores`; `memoryUtilization`'s `idleRateFraction`, `allocatedMB`, `peakExecutors`, `appDurationMs` and `allocatedBytes`; and `retryWaste`'s `extended` text. `value` is now always a number or `null`: `stageFailed`, `configAudit` and `incompleteRun` rows carry their text in a new `valueText` field instead. Finding ids are unchanged.
