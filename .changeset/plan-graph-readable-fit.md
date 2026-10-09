---
'sparkforensics-web': patch
---

The plan graph opens at a readable zoom: the fit never drops below the zoom that renders the smallest node text at 11 px, and a plan too large for the canvas scrolls instead of shrinking. The layout stays one right-to-left flow on desktop, so a long chain scrolls sideways, and stacks vertically on a phone-width viewport. The legend starts collapsed, and the minimap appears only when part of the graph is off screen unless the rail toggle forces it on or off.
