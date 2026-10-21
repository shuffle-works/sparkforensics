---
'sparkforensics-web': patch
'sparkforensics-cli': patch
'sparkforensics-mcp': patch
'sparkforensics-server': patch
---

A failure in one widget, a stale chunk, a parse that fails after the log is read, or an HTML export with a missing or damaged `data.js` now shows a message with a way to recover, instead of a blank page or an endless "Parsing" screen. The parser worker reports a rejected parse (for example a file that changed after it was dropped) as an error.
