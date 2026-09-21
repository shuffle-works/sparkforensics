---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Vendor upstream's per-chapter docs pages instead of a single monolithic
page, memoize the detector-to-doc-anchor lookup, and single-source the
bottleneck sub-anchor mapping between docs-config.ts and update-docs.mjs.
