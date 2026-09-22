---
"sparkforensics": patch
---

Bump @testing-library/jest-dom from 6.9.1 to 7.0.1. No setup changes needed: the repo already registers matchers via the `@testing-library/jest-dom/vitest` subpath, and `@testing-library/dom` (now a required peer) is already satisfied transitively through `@testing-library/react`.
