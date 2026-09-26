---
"sparkforensics-web": minor
---

The run verdict says how the run ended. A run with a failed job leads with "This run failed" (or how many jobs failed), quotes the first line of the reason Spark recorded, and lists the failure before any speed-up; the step for that failure then points at the quoted reason and keeps the driver log for the full stack trace. A run whose jobs all succeeded says so. Finding rows no longer print a savings figure that rounds to zero, such as "0.0 core-h".
