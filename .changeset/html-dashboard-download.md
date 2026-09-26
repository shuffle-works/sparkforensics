---
"sparkforensics-web": minor
"sparkforensics-cli": patch
---

Download the self-contained HTML dashboard from the Export evidence menu. Until now it came only from the CLI's `--export-html`. The new item writes one `.html` file for the open run that opens in any browser with no server. It follows the Redact identifiers toggle and the Markdown and JSON naming, with a `-redacted` suffix when redaction is on. The main build ships the export template as `export-template.html` beside the app and fetches it only when someone picks HTML, so normal page loads don't carry it.

One file cannot carry the docs site that the CLI copies into its export folder. Without it, every docs link in that export would open a missing local `docs/` page. The download points those links at the published docs instead: the guide at shuffle-works.github.io/sparkforensics/docs/ and the tuning reference at shuffle-works.github.io/spark-tuning-reference/. We kept the links because the finding explanations are most of what a recipient needs to act on the report. The cost is that reading them needs a network connection, and they show the published docs rather than the docs of the version that made the file. The CLI export is unchanged and still links to its bundled docs.

The CLI and the dashboard now build the payload with the same core code: config audit, serialization, redaction, and the inline `window.__SPARKFORENSICS_RUN_GZ__` statement. The CLI's output is unchanged.
