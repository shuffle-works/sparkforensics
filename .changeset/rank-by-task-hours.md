---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Findings rank by the cluster time they cost. The verdict steps and the recommendations order warning and critical findings by the task time of the stage they sit on (`impactEstimate.stageTaskMs`), so both lists give the same order. The spill estimate counts the serialization and sort CPU that memory spill causes, as a share of the stage's task time scaled by the spilled volume relative to the bytes the stage read, and its assumptions text states that share. A `critical` band needs the finding's stage to carry at least 2% of the run's task time, otherwise it is capped at `warning`; failures and oversized-partition findings keep `critical`.
