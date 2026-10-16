---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

Cost-only estimates no longer read as run time. A cost-only (`resourceOnly`) figure that sums task time is printed as core time with its certainty, for example "0.2 core-h of task time (modeled)", on the dashboard, the Markdown report and the JSON rows. `rawWaste` keeps its value and unit, and `coreTimeMs` stays in milliseconds.

`impactEstimate.assumptions` names what an estimate's model assumes and leaves out, for example "assumes 200 MB/s per executor over 75 executors; counts disk spill only, not memory spill, serialization or GC", and each finding row carries `estimateProvenance`, the provenance sentence with those assumptions. `cachingOpportunity` reports the input its queries scanned (`rawWaste` in `bytes`, with `reread: true`) and how many queries scanned it, not a time. A `slowHost` task-time finding on one executor states `confidence: low`, a `validationRequired` sentence on how often the largest of N executors reaches the ratio by chance, and `executorCount` and `taskCount`. The report schema stays 5 and the metrics schema stays 1; the fields are additive, and finding ids and bands do not change.
