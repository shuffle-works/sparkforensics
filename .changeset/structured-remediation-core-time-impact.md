---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Evidence report finding rows gain two machine-readable fields. `remediation` lists the Spark property changes a finding's recommendation names (`{kind: "conf", key, direction, suggested}`), with `suggested` set only where the detector computes a value (for example the shuffle partition count that brings partitions to 128 MiB) and `null` otherwise. `impactEstimate.coreTimeMs` gives the cluster capacity a fix frees in core-milliseconds next to the wall-clock range: the wall-clock claim times the run's peak executor cores, or a core-time raw figure as measured. It is `null`, never 0, when the log has no executor cores or the finding has no core-time figure. The existing fields and the report's schema version are unchanged.
