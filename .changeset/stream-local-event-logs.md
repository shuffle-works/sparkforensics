---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

`sparkforensics-analyze` and the MCP `path` source now read a local event log in 512 KiB slices
instead of loading the whole file first. Logs larger than 2 GiB no longer fail with "File size
(...) is greater than 2 GiB", and peak memory no longer grows with the file's size: a 1.5 GiB
uncompressed log now peaks at about 330 MB instead of 1.8 GB. Every format streams, including
gzip, zstd, lz4, snappy, History Server `.zip` downloads and rolling-log directories.
