# SparkForensics

[![CI](https://github.com/shuffle-works/sparkforensics/actions/workflows/ci.yml/badge.svg)](https://github.com/shuffle-works/sparkforensics/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Your Spark job is slow. SparkForensics tells you why, and what to do about
it.

Drop a Spark event log in and get an evidence-backed breakdown of which
stages are slow, why, and how to fix them. Nothing installs on your
cluster and nothing leaves your machine.

**[Try it now →](https://shuffle-works.github.io/sparkforensics/)** with your
own event log. No install, no account, no upload.

<video src="https://github.com/user-attachments/assets/dcea1204-cb44-480c-a91b-96e520b9e61b" controls muted playsinline width="100%">
  Your browser doesn't support inline video. <a href=".github/assets/demo.mp4">Download the demo</a> instead.
</video>

Spark's own History Server gives you raw metrics. It won't tell you that
stage 14 spilled 40GB because of a skewed join key, or that cold start is
eating a third of the job. SparkForensics reads the same event logs and
turns them into findings.

## Why SparkForensics

- No install: it's a static web app. Drop a log file and read the
  dashboard; nothing is uploaded anywhere. An optional local-server mode
  adds a small Node companion for when a Spark History Server blocks
  direct browser fetches with CORS.
- Event logs are streamed and parsed off the main thread in a Web Worker,
  so a 240MB+ (or multi-GB) NDJSON log doesn't freeze the tab.
- About 25 built-in detectors cover skew, shuffle, spill, GC
  pressure, stragglers, cold start, cache/memory utilization, autoscaling
  churn, job/stage failures and partition sizing, plus a SQL Plan Advisor
  (duplicate subtrees, small files, broadcast sizing) and a config audit.
  Full roster in [`docs-site/contributor-guide/architecture/detector-contract.md`](docs-site/contributor-guide/architecture/detector-contract.md).
- Fix These First orders every finding by its estimated wall-clock impact,
  not severity alone, so the top row is the fix worth doing first.
- Run comparison (A/B) mode structurally matches stages across two
  runs of the same job and shows which stages regressed, rather than every
  difference.
- Every finding tracks what it could and couldn't confirm from the log, so
  you know when to trust a flag and when it's a hint worth checking
  manually.
- A headless CLI (`sparkforensics-analyze`) evaluates a
  run against budget thresholds (max runtime, skew, spill, failure rate...)
  and exits non-zero on violation, so a regression can fail a build. The run
  can come from a local event-log file/directory or, with `--shs-base-url`,
  fetched directly from a Spark History Server.
- An MCP server (`sparkforensics-mcp`) exposes
  `diagnose_run` (thresholded findings + remediation text), `get_run_summary`
  (app/stage/job/sql counts and duration), `compare_runs` (categorized
  findings delta between two runs), `evaluate_budgets` (evaluate a run,
  optionally against a second run, against pass/fail budget thresholds),
  `get_finding_evidence` (raw evidence for one finding), and
  `get_finding_documentation` (detection/tuning reference docs for one
  finding type) so an LLM agent can investigate a run directly.
- For running the analyze CLI automatically after every Spark job instead of
  by hand, see
  [sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator),
  an Airflow operator that runs SparkForensics on a job's event log and acts
  on the result.

Unlike tools that need a cluster-side plugin or a running
server plus an LLM agent (Spark History Server MCP tools), SparkForensics
needs nothing installed anywhere else: the event log and a browser tab
are enough.

## Get started

```bash
git clone git@github.com:shuffle-works/sparkforensics.git
cd sparkforensics
npm install
npm run dev
```

Open the URL Vite prints and drop a Spark event log onto the page. Rather
skip the install? Use the [live demo](https://shuffle-works.github.io/sparkforensics/)
instead.

For a one-shot check with no browser, the kind a CI pipeline can gate on:

```bash
npx sparkforensics-analyze path/to/eventlog --max-runtime 3600000 --max-skew 3
```

That's a headless run against budget thresholds. See [Command-line
reference](#command-line-reference) below for HTML export, Spark History
Server fetching, baseline comparisons, and redaction.

## Development

### Install and run

Run `npm install` first if you haven't (see [Get started](#get-started)
above). For a production bundle: `npm run build`, then serve `dist/` with
any static file server. Asset URLs are relative, so the bundle also works
under a URL subpath.

> **Note:** The app must be served over HTTP: `file://` URLs block Web
> Worker module imports in Chrome.

### Deploy modes

This app runs in two modes:

- Static mode (e.g. GitHub Pages, or any plain file server): **Choose file**
  is the normal browser-local path for a single event log. **Choose
  rolling-log folder** is available only for an `eventlog_v2_*` directory.
  Deploy the output of `npm run build` from `dist/`. Fetching directly from
  a Spark History Server is not available: the browser's CORS policy blocks
  it and a static host can't proxy the request. If a History Server load
  cannot be used, choose a local event-log file instead.
- Local-server mode is a small Node companion that serves this app *and*
  fetches from a Spark History Server on your behalf (server-to-server, so
  no browser CORS restriction). Useful when the SHS is behind a VPN or
  isn't CORS-configured.

Run local-server mode with:

```bash
npx sparkforensics-server
```

It listens on `http://127.0.0.1:4173` by default (override with `--port` or
the `PORT` env var) and binds to localhost only. Open the URL in Chrome and
use the **Fetch from Spark History Server** disclosure on the intake
screen.

History Server fetching requires local-server mode, a History Server
reachable from the machine running that server, and a supported base
application ID: `application_<timestamp>_<id>`, `local-<timestamp>`, or
`app-<identifier>`. Enter an optional attempt separately from the base
application ID. The local server sends no credentials and follows no
upstream redirects. Its recoverable errors intentionally omit upstream
response details; edit the fields or choose a local event-log file to
recover.

During development from a checkout, `npm run local-server` does the same
thing without publishing or installing the package.

#### Server configuration

All settings have working defaults; override them with environment
variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `4173` | Listen port (the `--port` flag takes precedence) |
| `SPARKFORENSICS_SHS_TIMEOUT_MS` | `30000` | Spark History Server fetch timeout: response headers must arrive within this window, and a streaming body that goes idle this long is cut off. Applies to both the `/shs-proxy` route and the MCP archive download. Progressing downloads of any size are unaffected. |
| `SPARKFORENSICS_MCP_CACHE_CAP` | `8` | Max parsed runs kept in the MCP tool cache |
| `SPARKFORENSICS_MCP_CACHE_TTL_MS` | `900000` | Idle eviction time for cached MCP runs (15 min) |
| `SPARKFORENSICS_MAX_ARCHIVE_BYTES` | `1073741824` | Largest SHS event-log archive the MCP tools or the `--shs-base-url` CLI mode will buffer (1 GiB); larger responses fail with `archive-too-large` |

### SHS-proxy route test fixture

The `/shs-proxy` route (`packages/core/src/proxy.js`) is covered by
`packages/server/test/shs-proxy-fixture.test.js`, part of the normal `npm run
test:server` suite. It loads a real event log from the
`spark-event-corpus-data` git submodule at `dev/log-corpus/` and asserts
the route streams it back as a valid ZIP. No Docker, no live Spark
process, and no live History Server are needed for this.

To verify the full Fetch-from-SHS UI flow by hand, including its
unreachable-upstream and application-not-found recovery states, point
`npm run local-server` at a real Spark History Server you have access to
and use its **Fetch from Spark History Server** disclosure. This repo no
longer ships its own Docker-based History Server fixture: once a real,
tagged event log is one `git submodule update` away via
`spark-event-corpus-data`, running a live Spark container here just to
prove the same `/shs-proxy` route duplicates coverage the corpus repos
already give for free, at the cost of a Docker dependency for every
contributor who touches that route.

### Running tests

```bash
npm test              # single run
npm run test:watch    # watch mode
npm test -- tests/parser-worker.test.js   # single file
```

## Command-line reference

Beyond the plain budget check in [Get started](#get-started), the same
`sparkforensics-analyze` CLI covers a few other jobs.

Write a self-contained HTML dashboard for the run instead of a JSON/Markdown
report, viewable offline over `file://` with no server:

```bash
npx sparkforensics-analyze path/to/eventlog --export-html path/to/output-dir
```

Fetch the run straight from a Spark History Server instead of a local file
(mutually exclusive with the positional path):

```bash
npx sparkforensics-analyze --shs-base-url http://history-server:18080 --app-id application_1234_0001 --max-skew 3
```

Compare a candidate run against a baseline (A/B) and fail the build on a
regression or a newly introduced critical finding:

```bash
npx sparkforensics-analyze path/to/candidate --baseline path/to/baseline --max-regression-pct 10 --fail-on-introduced critical
```

Redact the app id and any host/IP tokens before sharing the output outside
the environment that produced it:

```bash
npx sparkforensics-analyze path/to/eventlog --redact
```

Narrow the output's `findings` array to certain impact bands, types, or a
stage (`recommendations`/`cleanChecks` and the summary counts stay on the
full, unfiltered set):

```bash
npx sparkforensics-analyze path/to/eventlog --impact critical,warning --type stageSlowness --stage 12
```

Other budget flags round out the checks: `--max-spill <gb>`,
`--max-failed-task-rate <pct>`, and `--min-efficiency <pct>`. `--attempt-id`
pairs with `--shs-base-url`/`--app-id` for a non-default attempt;
`--regression-metric` picks which metric `--max-regression-pct` checks
(default `wallClock`); `--format md` switches output to Markdown (default
`json`); `--out <path>` writes it to a file instead of stdout. Exit codes:
`0` pass, `1` a budget was violated, `2` bad input/usage, `3` a budget was
inconclusive (e.g. missing evidence for a regression check).

> **Node version:** the published `sparkforensics-analyze`, `sparkforensics-mcp`,
> and `sparkforensics-server` packages all pre-strip their vendored
> TypeScript to plain JS at publish time, so `npx`-installed use only needs
> Node `>=18` (see each package's `engines` field). A checkout running any of
> the three straight off `packages/*/bin/` against `packages/core/src/*.ts`
> (the monorepo dev-mode fallback) needs a Node version with native
> (unflagged) TypeScript type-stripping instead: `>=22.18.0` on the Node 22
> LTS line, or `>=23.6.0` on Node 23+.

## Learn more

- [Getting started guide](docs-site/user-guide/getting-started.md): reading
  the dashboard, run comparison, CI and automation
- [Detector roster](docs-site/contributor-guide/architecture/detector-contract.md)
- [Worker protocol](docs-site/contributor-guide/architecture/worker-protocol.md)
- [Streaming/parsing design](docs-site/contributor-guide/architecture/overview.md#streaming)
- [Widget layout](docs-site/contributor-guide/architecture/widget-rendering.md)

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

[MIT](LICENSE)
