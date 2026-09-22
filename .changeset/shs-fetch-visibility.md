---
"sparkforensics": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The landing page now probes for a reachable local Spark History Server (an empty `fetch(/shs-proxy)` that returns 400 when a server is present, versus a network error or 404 on a static deploy) and, when one responds, shows a neutral callout above "Other sources" pointing the user at the disclosure to fetch a run from it directly. The disclosure itself still doesn't move or auto-expand, and nothing renders until the probe resolves, so a static deploy with no server sees no change.
