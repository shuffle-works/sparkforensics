---
"sparkforensics-web": minor
---

The built app carries a Content-Security-Policy that limits every request it makes to its own origin, and a new user guide page, "What stays on your machine", lists which modes contact the network. A browser test (`npm run test:e2e`) loads the sample run and the docs panel and fails on any other origin.
