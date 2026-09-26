---
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
"sparkforensics-web": minor
---

Savings figures in the evidence report (CLI md/json, MCP, and the dashboard's Export evidence download) now read as the dashboard prints them. Memory reads in GB-h from 0.1 GB-h up instead of MB-s, core time in core-s or core-h instead of core-ms, and a figure that rounds to zero is left out instead of printing "0.0 core-h". Each figure says what it counts ("of run time", "of core time", "of unused executor memory"): `recommendations` rows gain `impactMeaning`, finding rows gain `impact` and `impactMeaning`, and the Markdown adds a `- estimate:` line explaining how each figure was derived.

**Changed output:** time figures no longer carry an "Estimated" prefix. "Estimated 26.1s" is now "26.1s of run time", in `recommendations[].impact` and in the Markdown `impact:` lines. Update any script that matched the old prefix. The Markdown `- impact:` line now carries a single figure: it used to print the time range and the raw resource figure together, joined by a middot. The resource figure behind a time estimate has moved to the new `- estimate:` line, and a raw waste in milliseconds that is below the estimate's high is no longer printed.

The `--min-efficiency` budget (and MCP `minEfficiencyPct`) detail now reads "Busy core time 26% below budget 90%." instead of "Efficiency 26% ...", so it no longer reads as the dashboard's Efficiency tile, which measures something else. What the flag measures, the share of executor core time that ran tasks, is unchanged, and so are its exit codes.
