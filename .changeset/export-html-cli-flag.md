---
"sparkforensics-cli": patch
---

Add a `--export-html` flag to `sparkforensics-analyze` that writes a
self-contained, `file://`-openable dashboard export (an `index.html` plus a
`data.js` payload with the parsed run baked in) instead of the usual
markdown/JSON report, so a run can be shared and browsed with the full
dashboard, including the plan graph, without a running parser worker or file
server.

`--redact` composes with `--export-html`: the exported payload is now
redacted the same way the CLI's own report output is, including host values
under `app.config` keys ending in `host`/`hostname`.
