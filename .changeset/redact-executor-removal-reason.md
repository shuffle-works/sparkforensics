---
"sparkforensics-web": patch
"sparkforensics-cli": patch
---

`--redact` now replaces each executor's removal reason, so the HTML export no longer keeps a file path or data value from an ExecutorRemoved event's Removed Reason text.
