---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-web": minor
---

A run comparison now says what differs between the two runs, why the time moved and whether the output is the same. `comparison.comparability` (CLI JSON, `compare_runs` and the dashboard) holds the Spark configuration keys that differ, whether every stage pairs, input bytes, output rows and output bytes of both runs, the mean and peak executors, the overlap of the run windows and the ratios that bridge the wall-clock difference (task time, mean executors and task time's share of allocated core time). The verdict adds the tones `equivalent`, when configuration, plan and output agree and either the time gap is within noise or a capacity factor explains it, and `mixed`, when the wall clock and executor run-time or allocated core-hours move opposite ways; the title names where a time difference came from, so a smaller allocation is not read as a regression. Each metric row carries `withinNoise`, which never changes `direction`. New inputs: `--ignore-conf` and `--noise-band-pct` on the CLI, `ignoreConf` and `noiseBand` on `compare_runs`. The comparison page has a "What differs between the runs" card. Report schema 5 and metrics schema 1 are unchanged; every new field is additive.
