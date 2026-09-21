---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Speed up NDJSON event-log parsing ~4x (byte-scan line splitting, whole-chunk
decode with substring lines). Make the server bin executable and serve nested
directory-index requests.
