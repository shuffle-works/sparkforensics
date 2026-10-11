---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Comparing two runs normalizes each plan node's detail, name and attribute names once instead of once per stage that ran part of the node, which takes about 15% off the comparison step on large logs. The comparison output is unchanged.
