---
"sparkforensics-cli": minor
---

This release changes CLI results that existing CI jobs can depend on. A log with any skipped line exits `3` without budget flags. Budget flags reject a malformed number. `max-failed-task-rate` counts task failures that a retry recovered. An unwritable `--out` exits `2`.
