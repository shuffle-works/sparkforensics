---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

A tuned run now states and applies its thresholds consistently. `--max-skew` measures skew with the run's `skew.minTasksForP95`, so the budget checks the same ratio the skew finding reports. A tuned `floorPctWarn` or `floorPctCrit` on `skew` or `straggler` now grades that detector's impact bands. Caveat text that names a threshold (GC, skew, straggler, memory utilization, core locality) states the value the run used, not the default. The "estimate is unvalidated" caveat appears only on a tuned finding that has an estimate figure. A threshold file naming a built-in object key such as `constructor` or `toString` is refused as an unknown threshold. The MCP `compare_runs` Markdown now names the tuned thresholds, as `diagnose_run` does. The HTML export data format moves to version 3, so a dashboard built by this release refuses an older export with a message to export again, instead of rendering blank config-audit and stage-failure values. Default-threshold output is unchanged.
