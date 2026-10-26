---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

The core locality finding counts the hosts the run used, names the stages with the most non-local tasks and states the effective `spark.locality.wait`. It carries a `remediation` that raises that property when some tasks reached process- or node-local placement; when none did, it says a longer wait will not help and carries no remediation. Its core-time figure states the fetch cost it assumes per non-local task.
