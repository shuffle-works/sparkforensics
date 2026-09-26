---
"sparkforensics-mcp": patch
"sparkforensics-cli": patch
---

Run comparison finding rows now carry the finding's `type` next to its `rule`, so a sub-rule such as
`maxPartitionTooBig` can be grouped under its category (`partitionSizing`).
