---
"sparkforensics-web": minor
"sparkforensics-cli": minor
---

HTML exports now carry their conclusions. The run verdict, next steps, what the log could not check, savings figures and run-shape numbers are computed when the file is exported, by both `--export-html` and **Download HTML dashboard**, so an exported dashboard always agrees with the report the same run produced. The export data format moves to version 2: an exported dashboard refuses a file of another version with a message instead of rendering it partially, and its footer names the tool, core version and build that produced it.
