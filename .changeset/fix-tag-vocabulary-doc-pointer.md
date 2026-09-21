---
"@sparkforensics/core": patch
---

Fix `tag-vocabulary.test.js` to read the "Problem flagging" tag vocabulary
from `AGENTS.md` instead of the now-pointer-only `CLAUDE.md`. Test-only fix;
no user-facing behavior change.
