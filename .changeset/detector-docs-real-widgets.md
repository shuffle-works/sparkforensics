---
"sparkforensics-web": patch
---

Each detector docs page shows the dashboard's own widget for its example finding, with its charts and tables, instead of a plain card. A finding the run's verdict leads with appears as a verdict step ("What's happening", "What to try", potential savings); any other appears as a Findings row. Both open with the evidence panel expanded. The widget follows the docs page's light or dark theme and fits phone width. An HTML export, and so the docs widgets, offers the Task detail toggle only where it has something to show: an export carries no task data, so the toggle no longer opens to an empty section. A step or row whose widget has nothing to show beyond the line above offers no "Show evidence" control and no empty panel, in the dashboard and on the docs pages, and a route to it still lands on it. The docs widgets leave out the step labels, and each example shows a potential saving large enough to weigh.
