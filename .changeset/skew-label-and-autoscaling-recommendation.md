---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Stage Shape's task/stage skew row reads "Task/stage skew: 87%" (the longest task's share of the stage's wall-clock) instead of the raw fraction "0.87". The inverted autoscaling bounds finding now splits into the bounds as its measurement ("spark.dynamicAllocation.minExecutors (5) exceeds maxExecutors (3)") and "set min ≤ max." as its fix, so the fix no longer repeats the bounds under "What to try". Four other recommendations (low parallelism, speculation waste, autoscaling churn and caching opportunities) now follow the same "measurement: fix" shape.
