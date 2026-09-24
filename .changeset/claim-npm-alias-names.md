---
---

Adds the `sparkforensics-analyze` and `sparkforensics` npm packages: aliases that depend on
`sparkforensics-cli` and install its `sparkforensics-analyze` command. They start at the current
`sparkforensics-cli` version, and the maintainer publishes that first version by hand (see
`docs-site/contributor-guide/contributing.md`), so this changeset bumps nothing. The changesets
`fixed` group keeps later versions in step with `sparkforensics-cli`. The private root package is
renamed from `sparkforensics` to `sparkforensics-web` to free the name.
