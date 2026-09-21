---
"sparkforensics-cli": patch
"sparkforensics-server": patch
---

Memory Utilization no longer shows as an active widget when its only
finding is the `dataUnavailable` caveat (missing evidence because
`spark.eventLog.logStageExecutorMetrics` wasn't enabled for the run): that
caveat is already surfaced in the Evidence availability ledger, so it no
longer counts toward the widget's active-vs-clean decision. It now collapses
to the Clean-checks row in that case, matching the dashboard bundled into
the server and into the CLI's `--export-html` output.
