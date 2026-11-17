---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
"sparkforensics-web": patch
---

The slow-host (`HOST`) detector compares input and shuffle bytes per task instead of per executor total, so executors that lived for different spans of a stage (dynamic allocation, executor loss) no longer flag each other. Executor findings on every dimension stay at `info` and carry `medianValue` and `executorCount` in their evidence.
