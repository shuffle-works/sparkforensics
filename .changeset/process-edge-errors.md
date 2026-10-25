---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The CLI, the local server and the MCP server report process-edge problems as clear errors with correct exit codes. An unwritable `--out` (a missing folder, or a folder given as the path) exits 2 before the log is parsed. The server accepts only a whole-number port from 0 to 65535 from `--port`, `--port=<n>` or `PORT`, exits 2 on an invalid port or unknown flag, exits 1 with one line when the port is in use, answers a malformed URL escape with 400, answers `GET /.` with 403 instead of 404, and no longer echoes internal error messages in 500 responses. `sparkforensics-mcp` refuses to start on an unknown flag instead of serving default thresholds. MCP tools report a file-system error on an event log as `invalid-event-log`, without the absolute path. The MCP documentation tools report a file-system error as `access-or-upstream-failure`.
