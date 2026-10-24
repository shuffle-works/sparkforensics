---
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
"sparkforensics-server": patch
"sparkforensics-web": patch
---

The modeled spill CPU divides `diskBytesSpilled` by the bytes the stage read, so it no longer saturates on the deserialized `memoryBytesSpilled`. It charges 50% of the stage's task time per pass, capped at 60%, as measured on local sort stages.
