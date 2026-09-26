---
"sparkforensics-cli": patch
"sparkforensics-web": patch
---

`--export-html` no longer opens to a blank page for a log with cached RDDs. The export payload flattened the run's RDD storage map and each stage's executor metrics to empty objects, so the Cache Storage card threw on load. Nested maps and sets now keep their type through the export, with or without `--redact`.
