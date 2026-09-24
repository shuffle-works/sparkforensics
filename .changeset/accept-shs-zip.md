---
"sparkforensics-web": patch
"sparkforensics-server": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Parser: the dashboard, `sparkforensics-analyze` and the MCP `path` source now take a Spark History
Server download as-is, the `.zip` the Spark UI's download link or `GET
/api/v1/applications/<appId>/logs` returns. A single-file log is unwrapped; a rolling log's parts
under `eventlog_v2_<appId>/` are reassembled in index order, like a dropped rolling folder.
Before, the dashboard reported that the file was not an event log and the CLI exited 2 with "Not a
Spark event log", so the log had to be unzipped by hand first. Dropped zips and History Server
fetches share one zip reader, which reads the archive's central directory and inflates one entry
at a time in 512 KiB slices, so it never holds a decompressed entry whole. History Server fetches
of a compacted rolling log no longer re-read the parts already merged into its `.compact` file,
which the directory prefix used to hide from the rolling-log check.
