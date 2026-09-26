---
"sparkforensics-mcp": patch
"sparkforensics-cli": patch
"sparkforensics-web": patch
---

Run comparison finding rows now carry the finding's `type` next to its `rule`, so a sub-rule such as
`maxPartitionTooBig` can be grouped under its category (`partitionSizing`). The web comparison page's
**Findings by category** list uses it, so sub-rule rows show their category tag instead of the raw
rule name.
