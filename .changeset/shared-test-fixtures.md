---
"sparkforensics-web": patch
"sparkforensics-cli": patch
---

Tests share one analyzed-run helper and one stage factory, and a structure rule keeps tests and dev tools off the positional `analyze()` call. The corpus gate also pins config findings, the verdict's step order and the evidence keys each finding type publishes. `emptyAppModel()` has a single source.
