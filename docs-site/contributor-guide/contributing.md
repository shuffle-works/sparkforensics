# Contributing

## Where does new content go?

- `docs/` is for internal engineering records: ADRs, audits, competitive
  research. It stays flat, unstructured markdown, read by contributors
  through GitHub's own file viewer.
- `docs-site/` (this site) is the published documentation for users and
  contributors. If you're writing something a user or a first-time
  contributor should read, it belongs here, not in `docs/`.

## Linting before you commit

`npm install` runs the `prepare` script, which points git at `.githooks/`
(`git config core.hooksPath .githooks`). After that, every commit runs
`.githooks/pre-commit`: it lints any staged `.js`/`.mjs` files with eslint
and blocks the commit if linting fails. `git commit --no-verify` skips it.
To run the same linter by hand, use `npm run lint`.

## Changesets and releases

A changeset is required for a PR that touches `packages/cli`, `packages/mcp`,
`packages/server`, or the root site app (`src/`, `index.html`,
`vite.config.ts`, or the root `package.json`). Run `npx changeset add`,
answer its prompts, and commit the generated `.changeset/*.md` file. CI's
`changeset` job (`scripts/check-changeset.sh`) fails the PR otherwise, with
instructions to fix it. `docs-site/` and `docs/` are exempt: doc-only changes
don't need one.

Needing a changeset doesn't mean getting published, though. Only
`packages/cli`, `packages/mcp`, and `packages/server` publish to npm. The
root site (`sparkforensics` itself) is `"private": true` and never published;
its changeset only bumps its `package.json` version and writes a
`CHANGELOG.md` entry, via `.changeset/config.json`'s `privatePackages.version`
setting. `@sparkforensics/core` is the other private package but stays out
of this entirely (`.changeset/config.json`'s `ignore` list): it's vendored
into cli/mcp by filesystem copy at pack time, not read as a real dependency,
so versioning it would have no consumer.

A release itself is two merges, not one: merging your feature PR into `main`
runs `.github/workflows/release.yml`, which opens (or updates) a "Version
Packages" PR collecting all pending changesets. Nothing publishes yet.
Merging *that* PR is what actually bumps versions, writes changelogs, and
runs `npm publish` for whichever of the three publishable packages had
pending changesets.

Maintainers: this pipeline depends on the three package names being claimed
on npmjs.com and Trusted Publishing being registered against this repo (a
one-time manual bootstrap step, tracked separately). Until that's done, every
push to `main` will fail at the publish step. Check whether it's been done
before merging a "Version Packages" PR.

For the full setup and test workflow, see
[Development setup](./development-setup.md) and
[Testing & verification](./testing.md).
