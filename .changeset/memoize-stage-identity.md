---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

Run reports and run comparisons compute a stage's plan-derived identity once instead of once per stage. The SQL plan tree is indexed by stage id once per execution, and a stage with no attributed plan node reuses a cached whole-tree identity. On a 3.5 GB log the report's metrics step drops from about 0.56 s to about 0.10 s, a comparison of two 566 MB logs from about 0.98 s to about 0.25 s, and comparing runs in the dashboard no longer blocks the main thread for a second. The analysis output is unchanged.
