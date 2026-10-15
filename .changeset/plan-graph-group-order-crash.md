---
"sparkforensics-web": patch
---

The plan graph no longer goes blank on a large plan whose segments interleave, such as the Advanced filter on a plan of over a thousand operators. Dagre could drop three overlapping segment groups from its ordering pass and place two nodes on one slot, which made the layout throw. The layout now orders again with the groups in one fixed order when that happens, and plans that laid out before keep their positions.
