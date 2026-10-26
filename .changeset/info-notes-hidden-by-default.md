---
'sparkforensics-cli': minor
'sparkforensics-mcp': minor
'sparkforensics-server': minor
'sparkforensics-web': minor
---

Info findings are hidden by default. The CLI report and `diagnose_run` list critical and warning findings, and `notesHidden` counts the info findings left out; the Markdown report says so too. `--impact critical,warning,info` and `minBand: "info"` list every band. The dashboard's Findings list leaves out info findings until the impact filter names the info band, and a line above the list counts the hidden notes and has a **Show notes** button. `Findings to act on` counts critical and warning findings only. The Markdown report lists a host or executor that lags in several stages once, with its stages.
