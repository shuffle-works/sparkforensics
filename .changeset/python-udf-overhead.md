---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

A new `pythonUdf` finding (tag `PLAN`) flags stages that run row-at-a-time Python UDFs (`BatchEvalPython`). It reports the bytes sent to and returned from the Python workers, read from Spark's executor-side SQL metrics, and the time of the stages that ran them, and suggests Arrow-optimized Python UDFs (`spark.sql.execution.pythonUDF.arrow.enabled`, Spark 3.4 and later) or a pandas UDF. `ArrowEvalPython` is never flagged. The finding is informational and fires only when the stages sent at least 64 MiB and ran for at least 30 seconds together; both floors (`minBytesSent`, `minStageMs`) can be tuned with `--thresholds`. The thresholds are conservative guesses, not tuned against real workloads.
