---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The autoscaling churn finding measures only executors that were removed. An executor still alive at app end no longer counts as short-lived, so short runs and late scale-ups no longer raise a false critical. The 5-executor floor applies to removed executors, and the finding text, threshold summary and widget now say the share is of removed executors.
