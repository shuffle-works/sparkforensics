---
"sparkforensics-web": patch
"sparkforensics-cli": patch
"sparkforensics-mcp": patch
---

A skew finding and a straggler finding on the same stage now carry the overlap note whichever way skew measured the stage. Both detectors claim the same replayed tail recovery, but the note appeared only when skew used its max/median ratio (stages under 20 tasks), so a P95/median skew finding beside a straggler finding showed two equal recoverable-time figures with nothing saying not to add them. The note now reads "both measure the same slow-task tail".
