---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics-web": minor
---

The evidence report (CLI md/json, MCP `diagnose_run`, and the dashboard's Export evidence download) now opens with the dashboard's run verdict. A new `verdict` field carries the same title, summary sentences and first three next steps the verdict card shows, in the same order: grouped by place, ranked by potential savings, with failures first on a run whose jobs failed. Each step has its action, what to try, the potential savings and what that figure counts, and the other finding types flagged at the same place. `copyText` is the card's "Copy next steps" checklist. The Markdown adds a `## Verdict` section above "Fix these first", which stays: it ranks fix types, the verdict ranks places. The verdict's ranking and wording moved from the dashboard into the shared core package, so both paths run one implementation.
