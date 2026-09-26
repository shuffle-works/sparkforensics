---
"sparkforensics-web": patch
---

Clean checks no longer lists checks the log could not run as passed. On a log with no finished stage, every per-stage check, and any check whose only finding is a missing-data caveat, moves to a neutral "Not checked on this log" group, using the same rule as the verdict.
