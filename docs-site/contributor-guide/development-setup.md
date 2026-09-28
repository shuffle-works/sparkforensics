# Development setup

This page is for working on SparkForensics itself. To run the dashboard as a
user, see [Run it locally](../user-guide/getting-started.md#local-server-mode).

Clone the repo, then:

```bash
git submodule update --init dev/log-corpus   # or: git clone --recurse-submodules
npm install
npm test              # vitest run: the root suite (site app and dev tooling)
npm run test:watch    # vitest, watch mode
npm run test:core     # packages/core's suite: detectors, analyzer, parser, MCP tools
npm run test:cli      # packages/cli's suite (packs and spawns the real tarball)
npm run test:mcp      # packages/mcp's suite (packs and spawns the real tarball)
npm run dev           # Vite dev server for the app itself
npm run build         # production build, outputs dist/ (plus dist/export-template.html, the HTML download's template)
npm run preview       # serves dist/ locally
npx tsc --noEmit      # typecheck (strict TypeScript across src/ and packages/core/src/)
npm run lint          # eslint over the repo
node packages/cli/bin/sparkforensics-analyze.mjs <file|rolling-log-dir>   # run the CLI analyzer against a log, outside the browser
```

`npm run test:coverage`, at the root or inside any `packages/*` directory,
runs that package's suite with `--coverage` (v8 provider, `lcov` and `text`
reporters, written to `<pkg>/coverage/lcov.info`). CI's `build`, `core`,
`cli`, `mcp` and `server` jobs all run through it and upload to Coveralls,
merged by a final `finish` job.

The dashboard's **Download HTML dashboard** fetches `export-template.html`
from beside the app, so under `npm run dev` it fails with an error toast;
use `npm run build && npm run preview` to try it.

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
tuning-reference lookups come back empty. `npm run docs:bump [-- <sha>]` moves
the pin (default: upstream head), regenerates the docs and writes the
changeset; put the compare link it prints in the PR body.
`npm run docs:bump -- --check [<sha>]` runs the anchor gate and writes
nothing; `.github/workflows/tuning-reference-drift.yml` runs it with
`test:core` every week.

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
`spark-event-corpus-data` repo. It's optional locally: if you skip the
`git submodule update` step above, the corpus-backed tests (such as
`packages/server/test/shs-proxy-fixture.test.js`) report as skipped rather
than failed, which is expected, not a bug. CI always checks it out and runs
them, plus the [corpus regression snapshot](./testing#corpus-regression-snapshot).

The `packages/server/` package (the optional local-server deploy mode) keeps
its own dependencies and test suite. Run it from the repo root: a second
`npm install` inside `packages/server` prunes the shared root
`node_modules`'s workspace symlinks.

```bash
npm run test:server   # runs packages/server's own suite, not part of `npm test`
```

Packing or releasing `packages/server/` builds the docs site for you: its
`prepack` runs `packages/server/scripts/copy-frontend.js`, which runs the root `npm run build`
(`docs:build` included), so the packed artifact always ships `/docs/`.

This docs site has its own dev loop:

```bash
npm run docs:dev       # VitePress dev server for docs-site/
npm run docs:build     # production build; also checks internal links/anchors
npm run docs:preview   # serves the built docs site locally
```

## Generated and vendored files

- `packages/core/src/docs-content/detection/*.md` is generated from
  `docs-site/user-guide/understanding-findings.md`. After editing that guide,
  run `npm run split-detection-docs` and commit the output, or
  `tests/detection-docs-split.test.js` fails.
- `packages/{cli,mcp,server}/vendor-core/` (gitignored) is rebuilt only at
  `prepack`. In the monorepo the bins load `packages/core/src/load-vendored.js`,
  which uses a leftover `vendor-core/` only while its `core-source-hash.txt`
  matches `packages/core/src`; otherwise it warns on stderr and runs the
  source.
- The CLI's `export-template/` has no such check: rebuild it with
  `node scripts/vendor-export-template.mjs` before trusting a local
  `--export-html`.

## The docs site's anchor clicks

VitePress installs a `window`-level, capture-phase click listener
(`node_modules/vitepress/dist/client/app/router.js`) that catches clicks on
any `<a href="#...">` pointing at the current page and scrolls to the target
itself, before a handler the theme adds on that element runs, so
`preventDefault()` there is too late. An interactive control built over
in-page anchors, such as the footnote-marker popovers in
`docs-site/.vitepress/theme/citation-chips.ts`, must drop the element's
`href` and restore `role`, `tabindex` and keyboard handling by hand.

## Driving the app in a browser

- Sample logs: download one from a Spark History Server with
  `curl -o app.zip "<baseUrl>/api/v1/applications/<appId>/logs"` and drop the
  zip in as-is (single-file and rolling logs both unwrap), or the `.zstd`
  event log inside it. Private logs follow the naming rule in
  [Testing](./testing.md).
- Loading a file under Playwright: the drop zone prefers `showOpenFilePicker`,
  a native dialog that localhost Chromium can't drive. Run
  `await page.evaluate(() => delete window.showOpenFilePicker)` before
  clicking **Choose file**, then `setInputFiles` on
  `[data-testid=file-input]` or handle the `filechooser` event.
- Run comparison: on the landing page, click **Compare two runs**, fill the
  **Run A** and **Run B** slots the same way (each has its own
  `[data-testid=file-input]`), then click **Compare**. Both runs parse one
  after the other through the one worker. From a run's dashboard, the
  topbar's **Compare with another run** opens the same view with that run in
  Run A (a `cached` `RunSource`, not parsed again). **View run A/B dashboard**
  drills into one run, and **← Back to comparison** returns.
- The landing page's **Try a sample run** (`src/view/DropZone.tsx`) loads a
  gzip-compressed corpus log from `public/sample-runs/`. It was chosen by
  running `sparkforensics-analyze --format json` over every corpus candidate
  and taking the one with the most findings. Repeat that scan, against the
  current corpus, before swapping the bundled sample.
- Screenshots on a PR: the `gh` token can't use GitHub's browser-only
  attachment uploader. Commit the PNGs to a throwaway asset branch and embed
  them by commit SHA as
  `https://raw.githubusercontent.com/<owner>/<repo>/<sha>/<path>.png`. The
  repo is public, so every reader's browser loads them, and the binaries stay
  out of the feature diff.
