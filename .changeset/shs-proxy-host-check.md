---
"sparkforensics-server": patch
---

The local server's Spark History Server proxy now answers only requests addressed to the server itself (`127.0.0.1:<port>` or `localhost:<port>`), the same hosts the `/mcp` route accepts.
