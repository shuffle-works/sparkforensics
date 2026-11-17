---
"sparkforensics-analyze": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics": patch
"sparkforensics-web": patch
---

The run comparison verdict states a change in input or output volume with the same figures the Comparability section prints. It names introduced and resolved findings by category and impact band instead of netting counts per category, so a resolved critical finding stays visible. A `low` confidence comparison gets a one-sentence verdict that gives the reason. Output rows now use the noise band like the byte figures, so a small row-count change no longer marks the output as different.
