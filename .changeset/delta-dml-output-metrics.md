---
'@sparkforensics/core': minor
'sparkforensics-cli': minor
'sparkforensics-mcp': minor
---

Delta MERGE, UPDATE and DELETE writes in `writeTargets` report `outputRows` and `outputBytes`, the rows and bytes written to new files, read from the command node's SQL metrics. A MERGE writes its inserted, updated and copied rows, an UPDATE the rows it touched, and a DELETE the target rows it copied (0 when it rewrote no file). `outputRowsSource` has a new value, `commandMetric`, for these figures. A new `changedRows` field holds the updated-row count of an UPDATE and the deleted-row count of a DELETE; it is `null` for every other command. `mergeRows` is unchanged.
