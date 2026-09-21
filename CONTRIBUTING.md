# Contributing

Issues and PRs are welcome.

## Setup

```bash
npm install
npm run dev
```

Drop a file from `examples/` (or a real Spark event log) onto the running
dev server to try changes live.

## Before opening a PR

Run the same checks CI runs:

```bash
npm test
npx tsc --noEmit
npm run lint
npm run build
npm run test:core
npm run test:cli
npm run test:mcp
```

The local-server deploy mode in `packages/server/` has its own package and
test suite. Run it from the repo root, without a separate `cd`/install
(a second `npm install`/`npm ci` inside `packages/server` prunes the shared
root `node_modules`'s workspace symlinks):

```bash
npm run test:server
```

## Scope notes

- All of `src/` is TypeScript, except the two vendored third-party
  decompressors `src/vendor/fflate.js` and `src/vendor/fzstd.js`, which stay
  plain JS. See the
  [detector roster](docs-site/contributor-guide/architecture/detector-contract.md),
  [worker protocol](docs-site/contributor-guide/architecture/worker-protocol.md),
  and [render sequence](docs-site/contributor-guide/architecture/widget-rendering.md)
  before adding a detector or changing a threshold.
- Keep rendered UI copy domain-agnostic: no company, industry, or dataset
  references in output.
- New bottleneck findings should check the
  [detector roster](docs-site/contributor-guide/architecture/detector-contract.md)
  first: several existing Spark log-analysis tools cover overlapping ground,
  and a "new" category may already exist here.
