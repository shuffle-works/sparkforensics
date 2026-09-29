---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

The verdict explains step grouping once. Its summary now reads "Findings on one stage are grouped, and their savings overlap.", and a grouped step says "Also flagged here, likely the same cause:" before the other findings' names instead of repeating why they were grouped. The CLI's Markdown report uses the same line. Each verdict step and each finding in the stage details dialog shows the finding's own measurement under "What's happening" and only the fix under "What to try". Before, "What's happening" gave the tag's general definition, the same text for every finding of that tag, and "What to try" repeated the measurement ahead of the fix. A recommendation with no measurement shows only "What to try".
