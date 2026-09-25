---
"sparkforensics-web": minor
"sparkforensics-server": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
---

Cache storage (`CSTOR`): the cached-partition counts and memory/disk sizes now come from
`SparkListenerBlockUpdated` events, which Spark writes when
`spark.eventLog.logBlockUpdates.enabled=true`. Before, the check read only the RDD Info in
stage-submission events, whose cache figures Spark has written as 0 since 2.3, so it could not fire
on any current Spark version. Each RDD reports its peak cache residency, so an `unpersist()` before
the log ends no longer hides partitions that never fit. Thresholds are unchanged. RDD Info stays as
the fallback. When a run persists RDDs but its log has neither source and block-update logging was
off, the check reports that cache
storage was not logged, naming `spark.eventLog.logBlockUpdates.enabled`, instead of listing Cache
Storage as a passed check. Block-update lines for broadcast and shuffle blocks are dropped before
JSON parsing.
