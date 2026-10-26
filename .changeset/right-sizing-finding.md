---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": patch
---

A new `rightSizing` finding (tag `UTIL`) says how many cores a run needs. It takes the smallest core count whose modeled stage time stays within 10% of the observed time, and reports it when that is at most 75% of the cores held at peak on a cluster of at least 8 cores, with the modeled and observed times in its text and evidence. It is always low confidence and stays silent when the model misses the observed stage time by more than 20%. `--thresholds` changes `tolerancePct`, `maxCoreShare`, `minBaselineCores` and `maxModelErrorPct`.
