---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Both packages now ship with their third-party code bundled (`zod` and the MCP SDK) and declare no runtime dependencies. An install no longer resolves dependency ranges, so a pinned version such as `npx -y sparkforensics-mcp@0.13.0` runs the same code every time. Each tarball includes `THIRD-PARTY-LICENSES.txt` with the license text of everything bundled.
