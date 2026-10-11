---
"sparkforensics-cli": patch
"sparkforensics-web": patch
---

perf: the CLI starts faster. It reuses V8's compiled code for the core modules across runs (Node 22.1 and later), and building a run's clean-check threshold summaries no longer loads ICU. A small log analyzes about 25 percent faster end to end; output is unchanged.
