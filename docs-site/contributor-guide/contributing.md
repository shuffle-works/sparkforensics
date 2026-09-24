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
`packages/server`, `packages/analyze`, `packages/sparkforensics`, or the root site app (`src/`, `index.html`,
`vite.config.ts`, or the root `package.json`). Run `npx changeset add`,
answer its prompts, and commit the generated `.changeset/*.md` file. CI's
`changeset` job (`scripts/check-changeset.sh`) fails the PR otherwise, with
instructions to fix it. `docs-site/` and `docs/` are exempt: doc-only changes
don't need one.

Needing a changeset doesn't mean getting published, though. Only
`packages/cli`, `packages/mcp`, `packages/server`, and the two alias packages
publish to npm. The aliases, `packages/analyze` (`sparkforensics-analyze`) and
`packages/sparkforensics` (`sparkforensics`), hold no code of their own: each
depends on `sparkforensics-cli` and runs its `sparkforensics-analyze` bin, so
`npx sparkforensics-analyze` works outside a checkout and nobody else can
publish under either name. `.changeset/config.json`'s `fixed` group keeps
their versions equal to `sparkforensics-cli`'s, so every CLI release
republishes them. The root site (`sparkforensics-web`) is `"private": true`
and never published;
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
runs `npm publish` for whichever publishable packages had pending changesets.

### Publishing a new package name (maintainers)

The release workflow publishes through npm Trusted Publishing, which can't
create a package name that doesn't exist on npmjs.com yet. A new publishable
package needs one manual publish from a maintainer's npm account first, then
a Trusted Publisher entry. `sparkforensics-cli`, `sparkforensics-mcp` and
`sparkforensics-server` are set up. `sparkforensics-analyze` and
`sparkforensics` need this once, after the PR that adds them merges and before
the next release run publishes. Until then that run fails at their publish
step (the other packages still publish).

1. From a clean checkout of `main`, logged in with `npm login`, publish each
   package at the version in its `package.json`:

   ```bash
   (cd packages/analyze && npm publish --access public)
   (cd packages/sparkforensics && npm publish --access public)
   ```

2. On npmjs.com, open each package's **Settings**, add a **Trusted
   Publisher** for GitHub Actions with organization `shuffle-works`,
   repository `sparkforensics`, workflow filename `release.yml` and no
   environment, and save.
3. Optional: in the same settings page, set publishing access to require
   two-factor authentication and disallow tokens, so only the workflow can
   publish from then on.

`scripts/publish-packages.mjs` skips a version that's already on the
registry, so the next release run won't try to republish the bootstrap
version.

For the full setup and test workflow, see
[Development setup](./development-setup.md) and
[Testing & verification](./testing.md).
