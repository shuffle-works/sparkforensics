---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The idle-allocation finding (`utilization`) ranks by its idle core time on the same axis as stage task time, so it no longer always follows every stage finding in `verdict.steps`, `recommendations` and the dashboard lists. Its impact band now grades its idle core time against the run's allocated core time on the usual floors, where it was always info.
