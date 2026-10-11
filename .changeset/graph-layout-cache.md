---
"sparkforensics-web": patch
---

perf: the plan graph view reuses a graph's node positions when only the node data changes. Switching the duration attribution, or returning to a node filter or scope already shown, no longer runs the layout again; on a plan of about 1,100 operators the duration switch drops from about 1 second to under 150 ms. The first open of a graph takes the same time, and the layout is unchanged.
