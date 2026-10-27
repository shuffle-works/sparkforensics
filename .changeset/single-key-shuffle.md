---
'sparkforensics-cli': minor
'sparkforensics-mcp': minor
'sparkforensics-server': minor
'sparkforensics-web': minor
---

A shuffle partition skew finding names a single key when the median partition is empty and the largest partition holds at least 90% of the stage's shuffle read. It says almost all rows share one key (often NULL or a constant), so more partitions will not help, and advises a broadcast hint, filtering or splitting out the NULL rows, or giving them a random key. The finding carries `evidence.singleKey`. When the same stage also has a missed broadcast, the finding points to it, including when automatic broadcast is disabled.
