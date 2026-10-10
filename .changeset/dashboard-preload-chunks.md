---
"sparkforensics-web": patch
---

perf: the dashboard appears about 250 ms sooner after a log finishes parsing. The dashboard and its widget chunks now load while the log parses, so opening a run no longer waits out React's 300 ms Suspense reveal delay on the "Loading dashboard" fallback. The rendered dashboard is unchanged.
