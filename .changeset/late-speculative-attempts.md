---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
---

The Speculation waste (`SPEC`) finding now counts losing speculative attempts whose TaskEnd arrives
after their stage's StageCompleted. Spark kills the losing copy only once the stage finishes
("Stage cancelled: Stage finished"), so on a real cluster this is the usual order, and the parser
used to drop those attempts, leaving the finding silent for runs with speculation enabled. Only the
stage's speculation waste totals change; every other stat still excludes late attempts.
