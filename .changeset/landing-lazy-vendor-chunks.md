---
'sparkforensics-web': patch
---

Stop the landing page from preloading the charts and plan-graph vendor chunks. React and its runtime modules are now emitted in `react-vendor` instead of inside those two chunks, so the entry chunk no longer imports from them and they load only with the views that use them.
