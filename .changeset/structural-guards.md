---
"sparkforensics-web": patch
---

Guards keep the dashboard's evidence panels decided from data. `npm run lint:structure` runs ast-grep rules that ban reading rendered output to decide what to render (DOM probes, observers, clones, text reads), hiding output with a flag, DOM queries in widgets, impure content checks and hand-built evidence panels. Behaviour tests check that each widget's content check matches its panel, that closed panels mount no widget, and that a route to each example finding lands on a visible element of that finding.
