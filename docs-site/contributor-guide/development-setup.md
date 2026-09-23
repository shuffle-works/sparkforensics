# Development setup

Clone the repo, then:

```bash
git submodule update --init dev/log-corpus   # or: git clone --recurse-submodules
npm install
npm test              # vitest run: the full unit/component suite
npm run test:watch    # vitest, watch mode
npm run dev           # Vite dev server for the app itself
npm run build         # production build, outputs dist/
npm run preview       # serves dist/ locally
npx tsc --noEmit      # typecheck (strict TypeScript across src/)
npm run lint          # eslint over the repo
node packages/cli/bin/sparkforensics-analyze.mjs <file|dir>   # run the CLI analyzer against a log, outside the browser
```

`npm install` also runs the `prepare` script, which points git at
`.githooks/`. After that, a pre-commit hook lints staged JS files on every
commit. Fix what it reports, or skip it with `git commit --no-verify`.

`dev/log-corpus` is a git submodule pointing at the public
`spark-event-corpus-data` repo. It's optional: if you skip the
`git submodule update` step above, `packages/server/test/shs-proxy-fixture.test.js`
will report as skipped rather than failed, which is expected, not a bug.

The `server/` package (the optional local-server deploy mode) keeps its own
dependencies and test suite. Run them separately:

```bash
npm run test:server   # runs server/'s own suite, not part of `npm test`
```

Packing or releasing `server/` builds the docs site for you: its `prepack`
runs `scripts/copy-frontend.js`, which runs the root `npm run build`
(`docs:build` included), so the packed artifact always ships `/docs/`.

This docs site has its own dev loop:

```bash
npm run docs:dev       # VitePress dev server for docs-site/
npm run docs:build     # production build; also checks internal links/anchors
npm run docs:preview   # serves the built docs site locally
```
