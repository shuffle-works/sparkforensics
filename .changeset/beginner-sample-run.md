---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The landing page now offers a "Try a sample run" option for visitors who don't have a Spark event log of their own. It loads a bundled, gzip-compressed real event log (picked by running the analyzer over every corpus candidate and taking the one with the most findings) so a first-time user can see the dashboard without hunting for their own data.
