---
"sparkforensics-web": minor
---

The run verdict says what it could not check. When the log lacks evidence a check needs, such as executor metrics for memory or block updates for cache storage, the verdict ends with "Not checked on this log", and each line names the setting to turn on for the next run. A run is called clean only when nothing is missing, and a log in which no stage finished says so instead of "Every check passed".
