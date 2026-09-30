---
"sparkforensics-mcp": patch
---

`get_finding_documentation` returns corrected detection text for thirteen tags, regenerated from the user guide. `COLD` now recommends keeping warm executors or raising the dynamic-allocation minimum instead of turning dynamic allocation on, `SLOW` says it fires on any stage of 15 minutes or more that has no `HOST` finding, and the `SKEW`, `SPILL`, `GC`, `FAIL`, `HOST`, `MEM`, `CACHE`, `CFG` and `PLAN` entries state the thresholds and variants the detectors use. The `SPEC` and `CHRN` entries no longer call their thresholds unvalidated.
