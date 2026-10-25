---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

`--redact` (and the MCP `redact` parameter) replaces a single-word URL host, such as the bucket in `s3a://data/logs`, only inside the URL. A bucket named `info` or `shuffle` no longer rewrites finding fields such as `type` and `impactBand`, which made `--redact` and MCP `diagnose_run` with `redact: true` fail or return wrong values, and it no longer rewrites the same word in recommendation text.
