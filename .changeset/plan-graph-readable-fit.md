---
'sparkforensics-web': patch
---

The plan graph opens at a readable zoom: the fit never drops below the zoom that renders the smallest node text at 11 px, and a plan too large for the canvas scrolls instead of shrinking. A long chain of stages stacks vertically when the canvas is taller than it is wide (a phone). The legend starts collapsed, and the minimap appears only when part of the graph is off screen.
