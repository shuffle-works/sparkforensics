---
"sparkforensics-web": minor
---

The run verdict no longer calls a run clean when the log lacked evidence a check needs, such as executor metrics for memory or block updates for cache storage: a run is called clean only when nothing is missing, and a log in which no stage finished says so instead of "Every check passed".
