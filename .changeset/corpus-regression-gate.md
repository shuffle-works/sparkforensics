---
---

CI now checks out the public event-log corpus, gates detector output against a committed findings
snapshot, and installs the packed `sparkforensics-cli` and `sparkforensics-mcp` tarballs on Node 18.
Only test comments change under `packages/core`, so this changeset bumps nothing.
