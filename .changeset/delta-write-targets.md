---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
"sparkforensics-web": minor
---

`writeTargets` now names the target of Delta writes whose plan node carries none, which on real logs is every Delta command node.

- `MergeIntoCommand`, `UpdateCommand`, `DeleteCommand`, `WriteIntoDelta` and a Delta `SaveIntoDataSourceCommand` are resolved from the command's `Arguments:` line (a `table` as `database.table`, or the save's `path`), else from the single `_delta_log` path of the executions that share its root execution (`path`), else `null`. The parser now keeps that one line of the physical plan description for these commands; every other description is still dropped.
- A merge made with `DeltaTable.merge(...).execute()` has no command node and used to be missing from `writeTargets`. Each run of its `MERGE operation` executions is now one `DeltaMerge` write with `kind: "path"`. Runs that cannot be told apart from another merge (consecutive ids, overlapping start times, several or no paths) get a `null` target.
- `SqlExecutionStart` events now carry `rootExecutionId` into the model.
