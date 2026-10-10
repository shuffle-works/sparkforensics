---
"sparkforensics-cli": patch
---

Comparing two large event logs with `--baseline` is up to 30% faster: the smaller log parses on a worker thread while the main thread parses the other, so the pair takes about as long as its bigger log. Logs too small to repay a thread still parse on the main thread, and a worker that cannot run falls back to it. Peak memory rises by about the size of the smaller run's model. The comparison and every report are unchanged.
