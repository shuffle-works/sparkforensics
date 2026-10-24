---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---


Findings rank by the task time of the stage they sit on (`impactEstimate.stageTaskMs`), so `verdict.steps` and `recommendations` give the same order. The spill estimate adds the serialization and sort CPU of memory spill and states its assumptions. A `critical` finding needs its stage to carry at least 2% of the run's task time, or it drops to `warning`. Failures and oversized partitions stay `critical`.
