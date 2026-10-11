---
"sparkforensics-web": patch
---

perf: the plan graph view lays out large plans (200 or more operators) in a Web Worker, so the page keeps responding while the layout runs. On a plan of about 2,000 operators opened in full, the longest main-thread task drops from about 1.5 s to about 0.6 s. The layout is unchanged, and the view falls back to the main thread when a worker cannot start.
