---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

Detector entries now declare the finding types they emit, and the finding type union derived from them makes the compiler check that every per-type table (names, tags, threshold summaries, widget registry) has exactly one entry per type. No change to analysis output.
