---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

`--redact` and the MCP `redact` option now replace a failed stage's failure reason with `[redacted]`, since Spark's message can carry file paths and data values that no host or app-id pattern catches. This covers the `stageFailed` finding's text and the stage's failure reason in the HTML export. Shuffle I/O and the Skew, Stage Shape and Tiny Tasks cards now state their fix once above the rows, like every other finding card. The incomplete-log check's threshold summary names only the `ApplicationEnd` event it looks for.
