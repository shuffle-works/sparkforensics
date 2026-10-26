---
"sparkforensics-web": minor
---

The built app page carries a Content-Security-Policy that limits the page's own requests to its origin, and a new user guide page, "What stays on your machine", lists which modes contact the network. A browser test (`npm run test:e2e`) loads the sample run and the docs panel and fails on any request from the page, its workers or the docs iframe to another origin.
