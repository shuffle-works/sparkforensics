---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
---

`retryWaste` evidence tells an executor lost to the cluster from one lost to the application. The parser keeps `Exit Caused By App`, the flag Spark uses to decide whether a lost task counts toward `spark.task.maxFailures`. Each sampled attempt carries `lossReason` and `exitCausedByApp`, and the new `executorLosses` evidence groups the losses by executor and cause. When the dominant loss has `exitCausedByApp: false`, the recommendation says the executor exits were unrelated to the running tasks (for example preemption, node loss, or a container the resource manager or driver released) and do not count toward `spark.task.maxFailures`, and it gives no application fix.
