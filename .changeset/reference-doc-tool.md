---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Add the `get_reference_doc` MCP tool, which serves the Spark tuning reference
by anchor. The reference is now sourced from the docs-site markdown chapters
(single source) instead of vendored built HTML.
