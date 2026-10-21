---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

`--redact` (and the MCP `redact` parameter) now pseudonymizes the host of every URL (`hdfs://`, `jdbc:`, `spark://`, `s3a://`), `host:port` property values under any key and each stage's per-host statistics, and replaces user names in URL credentials, `/user/`, `/home/` and `/Users/` paths and `user=` values with `redacted-user`. Hosts are replaced in a single pass, so a run with hundreds of hosts and tens of thousands of stages redacts quickly. The help text and the CI guide list what `--redact` covers and what it leaves as written.

The Markdown report (`--format md`, MCP `format: "md"`) now prints the application name and other log-controlled text on one line with `[ ] < > |` escaped, so a name from another team's log cannot add a heading, a link or an HTML tag to a report pasted into a pull request or ticket.
