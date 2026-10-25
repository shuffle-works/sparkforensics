---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The idle-allocation finding (`utilization`) ranks by its idle core time on the same axis as stage task time, so it can lead `verdict.steps`, `recommendations` and the dashboard lists, which it usually does below 50% utilization. It is always a warning, where it was always info.
