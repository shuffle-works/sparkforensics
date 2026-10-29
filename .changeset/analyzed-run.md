---
"sparkforensics-web": minor
"sparkforensics-cli": minor
---

The HTML export data format moves to version 4: it carries the SQL executions whose start could not be read, and its interpretation refers to findings by id. The dashboard still opens version 3 exports. A run reopened from the recent list or from a comparison says its per-task detail is not available when it was not prefetched, and per-run view state such as the core usage histogram starts fresh for each run.
