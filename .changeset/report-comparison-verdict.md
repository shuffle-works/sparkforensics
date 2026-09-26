---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics-web": patch
---

Run comparisons outside the dashboard now open with the dashboard comparison page's verdict. The CLI's `--baseline` output gains `comparison.verdict` in JSON (`title`, `tone`, `sentences`) and a verdict at the top of the Markdown "Comparison to baseline" section, which also names run A (the baseline) and run B (the candidate). MCP `compare_runs` returns the same `verdict`. It leads with failed jobs when either run had any ("Run A had 1 of 3 jobs fail; run B completed"), states the run-time change with a 2% noise band, never calls a cut-off log's shorter time faster, and names which cost metrics and finding categories moved each way. The verdict and the finding-tag names it uses moved from the dashboard into the shared core package, and the core comparison result now carries each run's job outcome, so the dashboard and the headless paths run one implementation.
