---
"sparkforensics-web": patch
---

In the plan graph, each stage is drawn as one box with its name, duration and finding chips once, instead of two nested boxes. The box carries the selection ring and wraps only the plan segment the log pairs with that stage, so it never encloses a node of another stage. A segment with no stage pair of its own is drawn as a dashed box that names the nearest stage. The box is also drawn in the single-stage view, and it leaves no unused room under its content.
