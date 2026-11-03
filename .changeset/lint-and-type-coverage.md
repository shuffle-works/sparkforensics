---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

TypeScript and TSX files are linted with oxlint, and the CLI, MCP and server entry points and the core `.test.ts` files are type-checked. The detector registry, finding names, tags and threshold dependencies are keyed by finding type.
