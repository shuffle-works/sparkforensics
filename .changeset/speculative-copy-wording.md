---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The speculation-driven straggler finding now reads "N tasks finished on a speculative copy". It said "N speculative attempts discarded", but N counts the tasks whose copy won, not the discarded attempts.
