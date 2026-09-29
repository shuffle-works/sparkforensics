---
"sparkforensics-mcp": patch
---

`get_finding_documentation` returns corrected detection text for eleven tags, regenerated from the user guide. `COLD` now recommends keeping warm executors or raising the dynamic-allocation minimum instead of turning dynamic allocation on, `SLOW` says it fires on any stage of 15 minutes or more that has no `HOST` finding, and the `SKEW`, `SPILL`, `GC`, `FAIL`, `HOST`, `MEM`, `CACHE`, `CFG` and `PLAN` entries state the thresholds and variants the detectors use.
