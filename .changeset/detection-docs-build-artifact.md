---
'sparkforensics-web': patch
'sparkforensics-cli': patch
'sparkforensics-mcp': patch
'sparkforensics-server': patch
---

The per-finding detection reference files served by the MCP `get_finding_documentation` tool are generated from the user guide at build, test and pack time instead of being committed. Published tarballs contain the same files.
