---
"sparkforensics": patch
"sparkforensics-server": patch
---

Fixed three CodeQL security alerts: the local server no longer interpolates
the request method/URL into a `console.error` format string (a malformed
request could otherwise corrupt the logged message); the static-file server's
path-traversal guard now resolves the request path with `path.resolve`
instead of `path.normalize`/`path.join`, matching the pattern CodeQL
recognizes as sound; and the docs-site copy step's regex-escaping helper now
escapes every regex metacharacter, not only `/`, when building the pattern
used to rewrite absolute `/docs/...` references.
