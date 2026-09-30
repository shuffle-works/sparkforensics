---
"sparkforensics-web": patch
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Evidence report finding rows gain two machine-readable fields. `remediation` lists the Spark property changes a finding's recommendation names (`{kind: "conf", key, direction, suggested}`), with `suggested` set only where the detector computes a value (for example the shuffle partition count that brings partitions to 128 MiB) and `null` otherwise. `impactEstimate.coreTimeMs` gives the busy core time a fix removes in core-milliseconds next to the wall-clock range: the detector's measured core time where it has one (GC time, retried or discarded speculative attempts, the task time a skew or straggler fix removes), otherwise the wall-clock claim times the cores the finding's own stages kept busy. It is `null`, never 0, when neither can be derived. The existing fields and the report's schema version are unchanged.
