---
"sparkforensics-web": minor
"sparkforensics-cli": patch
---

Download the self-contained HTML dashboard from the Export evidence menu. Until now it came only from the CLI's `--export-html`. The new item writes one `.html` file for the open run that opens in any browser with no server. It follows the Redact identifiers toggle and the Markdown and JSON naming, with a `-redacted` suffix when redaction is on. The main build ships the export template as `export-template.html` beside the app and fetches it only when someone picks HTML, so normal page loads don't carry it.

One file cannot carry the docs site that the CLI copies into its export folder. Without it, every docs link in that export would open a missing local `docs/` page. The download points those links at the docs of the deployment it was downloaded from instead. At download time the dashboard resolves its own relative docs paths against the page's URL and writes the two resulting locations (the guide and the tuning reference) into the file, so no docs address is written into the source and a deployment that serves its docs elsewhere hands that location on unchanged. We kept the links because the finding explanations are most of what a recipient needs to act on the report. The cost is that reading them needs that deployment to be reachable. A file downloaded from a local server links to that server. The CLI export is unchanged and still links to its bundled docs.

The CLI and the dashboard now build the payload with the same core code: config audit, serialization, redaction, and the inline `window.__SPARKFORENSICS_RUN_GZ__` statement. The CLI's output is unchanged.
