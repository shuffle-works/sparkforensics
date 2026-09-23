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

The tuning reference under `packages/core/src/docs-content/{chapters,tuning,diagrams}`
isn't committed. It's generated from the `shuffle-works/spark-tuning-reference`
commit pinned in `packages/core/src/docs-content/upstream.json`: the first
`npm test`, `npm run docs:dev` or `npm run build` fetches it over HTTPS (about
2s, no credentials) and later runs reuse the gitignored copy while it matches
the pin. `npm run docs:fetch` does the same step on its own. Never edit those
folders: fix the content upstream, then `npm run docs:bump` to move the pin.
Running the MCP or CLI bins from source (`node packages/*/bin/...`) doesn't
fetch it, so run `npm run docs:fetch` first: without it the MCP's
tuning-reference lookups come back empty.

Offline, a cached copy keeps working. If the pin has moved since, `npm test` and
`docs:dev` warn and use the older copy, while `docs:build`, `npm pack` and
anything with `CI` set fail. To build from a local upstream checkout instead
(offline, or to preview upstream edits in this docs site before they merge),
set `SPARK_TUNING_REFERENCE_DIR`:

```bash
SPARK_TUNING_REFERENCE_DIR=../spark-tuning-reference npm run docs:dev
```

The same checks apply to that checkout. `npm pack` and CI accept it only when
it sits at the pinned commit with no uncommitted `content/` changes.

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
