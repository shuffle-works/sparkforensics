---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Run comparisons name the two runs Baseline and Candidate everywhere, matching the CLI's `--baseline` flag, instead of Run A and Run B. The compare slots read **Baseline** and **Candidate**, the verdict says "The candidate finished 9.9s faster than the baseline (37%)" or "The candidate had 2 of 5 jobs fail (baseline: none)", the buttons read **See where to start in the candidate**, **View baseline dashboard** and **View candidate dashboard**, and a load error starts "Baseline:" or "Candidate:". The verdict drops its "Run A is the baseline and run B the candidate." opener. The CLI's Markdown comparison and MCP `compare_runs` carry the same verdict text. MCP's Markdown names the runs as "Baseline: <run id> · Candidate: <run id>", and the CLI's, whose runs have no other name, opens with the verdict. MCP's `runIdA`/`sourceA` and `runIdB`/`sourceB` parameters keep their names.
