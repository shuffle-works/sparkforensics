---
"sparkforensics-web": minor
"sparkforensics-cli": patch
---

Download the self-contained HTML dashboard from the Export evidence menu. Until now it came only from the CLI's `--export-html`. The new item writes one `.html` file for the open run that opens in any browser with no server. It follows the Redact identifiers toggle and the Markdown and JSON naming, with a `-redacted` suffix when redaction is on. The main build ships the export template as `export-template.html` beside the app and fetches it only when someone picks HTML, so normal page loads don't carry it.

Exported dashboards no longer link to docs, in either form. Finding tags and "learn more" references render as plain text, and the Docs button and the newcomer primer's guide pointer are left out, so an exported file names no docs address and needs no network. With nothing linking to it, the CLI's `--export-html` folder no longer ships a `docs/` copy. The build pieces that existed only for that copy are gone: the export build's docs step, VitePress's multi-page mode, and the step that rewrote copied docs paths to relative ones.

The CLI and the dashboard now build the payload with the same core code: config audit, serialization, redaction, and the inline `window.__SPARKFORENSICS_RUN_GZ__` statement. The CLI's `data.js` is unchanged.
