---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

A finding's action label is now the same on every surface. Where a finding has no specific label, the dashboard, the verdict step and the report row all show the finding type's name; report rows used to show the raw type. The report's `cleanChecks` and `notRunChecks` now list `overBroadcast` and `underBroadcast`, matching the dashboard, where they used to list the `broadcastSizing` detector. The Config Audit widget's heading is now "Config Audit", the name used everywhere else, where it used to read "Config Sanity".
