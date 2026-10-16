---
'sparkforensics-mcp': minor
'sparkforensics-cli': minor
'sparkforensics-server': patch
'sparkforensics-web': patch
---

`diagnose_run` and `compare_runs` name the Spark application and the build that wrote the output: `app` and `generator` on a diagnosis, `baselineApp`, `candidateApp` and `generator` on a comparison. The CLI JSON carries `app` too, and `generator` in its `comparison`. The MCP server reports its package version in the handshake instead of a fixed `1.0.0`. Each findings row of a comparison has `stageLabels`, its stage names with the directories of call-site paths (YARN container directories, home directories, user names) removed. Each row of `stagePairs` has `stageLabel`, the same label for the pair's baseline stage. `stages` and the other raw stage names are unchanged and still carry the path, and `--redact` does not remove it, so show `stageLabel` and `stageLabels`. The verdict's finding count says it leaves out notes on an incomplete log or on data the log lacked. The tool descriptions say `runId` differs per tool by design. Report schema 5 and metrics schema 1 are unchanged: fields are only added.
