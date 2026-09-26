# Getting started

SparkForensics reads a Spark History Server event log and turns it into a
dashboard of flagged bottlenecks. No account needed.

## Run it locally {#local-server-mode}

The recommended way to run SparkForensics on your machine:

```sh
npx sparkforensics-server
```

Open `http://127.0.0.1:4173` and drop a log in. This is **local-server
mode**: it also fetches runs from a Spark History Server on your behalf.
Port and environment-variable overrides, and what changes for a static
deploy, are in the [project README](https://github.com/shuffle-works/sparkforensics#deploy-modes).

The [hosted demo](https://shuffle-works.github.io/sparkforensics/) runs the
same dashboard but can't fetch from a History Server. To work on
SparkForensics itself, see [Development setup](../contributor-guide/development-setup.md).

## Load a run

Drop a log file onto the landing page, or click **Choose file** to pick one.
Parsing runs in a background worker, off the browser's main thread, so a
multi-hundred-megabyte event stream doesn't freeze the tab. While it runs,
the progress screen shows how far along it is and roughly how long is left;
**Cancel** returns to the landing page.

No log of your own yet? Click **Try a sample run** on the landing page to
load a bundled example run and see a populated dashboard right away. **Where
do I find my event log?**, under the buttons, is a short guide to turning
event logging on and downloading a log from a History Server.

The app takes a newline-delimited JSON event log (one JSON event per line,
the format Spark writes to `spark.eventLog.dir`), either plain or
gzip/Zstandard/LZ4/Snappy-compressed. It also takes the zip a Spark History
Server hands back, from the Spark UI's download link or from `GET
/api/v1/applications/<appId>/logs`, as-is: drop the `.zip` and the app
unwraps the log inside it, or reassembles the parts of a rolling log. The zip
must hold one attempt: for an application that ran more than once, download
`/api/v1/applications/<appId>/<attemptId>/logs` instead.

Click **Other sources** on the landing page for two more ways in:

- **Choose rolling-log folder**, for an `eventlog_v2_*` rolling directory.
  Drop the folder or point the picker at it; the app reassembles its parts
  in order before parsing.
- **Fetch from Spark History Server**, to pull an application straight from
  a reachable History Server. This needs **local-server mode** (see [Run it locally](#local-server-mode))
  and an application ID in one of the forms Spark itself uses:
  `application_<timestamp>_<id>`, `local-<timestamp>`, `app-<id>`,
  `spark-<id>`, or `driver-<id>`. If the fetch fails, the panel names the
  problem (server unreachable, application not found, local server not
  running, and so on) and suggests what to try next.

Can't reach the History Server directly (it's only reachable through an SSH
bastion)? See [Alternative ways to get the logs](./alternative-log-retrieval.md).

Files you have already loaded stay listed under **Recent files** on the
landing page.

## Reading the dashboard

When parsing finishes, the dashboard shows a board of widgets, each in its
own card with a title. Every widget that flags a problem uses the same
convention: a colored impact dot (critical / warning / info) and an ALL-CAPS
tag for the bottleneck category (`SKEW`, `SPILL`, `GC`, and so on: see
[Understanding findings](./understanding-findings.md)). Widgets list every
affected stage, not just the worst one. The dot's color tracks how much run
time the finding could save you rather than how unusual the metric looks, so
a small-looking anomaly with a big payoff can outrank a dramatic one that
would barely move your run time.

The board opens with a verdict: one line saying where to start, a short
summary of what was found, and up to three numbered next steps. Each step
explains in plain language what is happening, says what to try, and has a
**Show evidence** button that jumps to the finding's detail widget. Findings
on the same stage are folded into one step, because they usually share a
cause and their savings overlap rather than add up. When most of the run's
executor capacity sat idle, the verdict starts with cluster size instead of
a small per-stage fix.

A run scorecard sits under the verdict: **Wall-clock** (total run time),
**Efficiency** (the share of that time with a stage running; higher is
better) and **Unused core time** (driver idle plus executor slack across the
whole run, so it can run higher than the idle capacity a verdict step
reports; lower is better). A collapsed **New to Spark tuning?** primer in the verdict
explains stages, tasks, executors, shuffle and how to read savings. Stage
labels such as **Stage 7** open that stage's details.
Below it, two tabs split the rest of the board:

1. **Findings**: every flagged finding and its detail widget, grouped by
   impact band (Critical, Warning, Info). Within a band, a recommendation row
   for a bottleneck type collapses into a summary row when it fires more than
   once; clicking the summary row expands its full list, and clicking any
   single row or widget jumps straight to that finding. Below the impact-band
   groups, memory and core-usage utilization always show, even on a clean
   run. Widgets that found nothing fold away into a "Clean checks"
   disclosure. This is the tab you land on.
2. **Full app report**: the wall-clock and executor timelines, the stage
   table, and the reference-only cards.

Click a finding's documentation link (or the topbar's **Docs** button) to
open the reference material in a slide-in panel beside the dashboard: the
dashboard stays visible and interactive, so you can check a metric against
the reference without losing your place.

### Advanced view

The topbar has an **Advanced view** toggle. It's off by default, which keeps
each widget to the finding itself and what to do about it. Turn it on to also
show confidence levels, supporting evidence, and documentation links for each
finding, plus a few extra table columns and the finding filter bar (impact,
type, stage). A filter that is already active, for example from a shared
link, keeps the filter bar visible either way. The scorecard switches from
plain captions to the raw run and idle-time breakdown, and the newcomer
primer is hidden. Your choice is remembered across runs.

### The rest of the topbar

Once a run is loaded, the topbar also carries a few more controls.
**New analysis** goes back to the landing page to load another run.
**Plan graph** opens an interactive node-and-edge view of the run's SQL
execution plan, filterable down to I/O operators (scan, exchange), a
broader "basic" set, or every operator. **Export evidence** downloads the
current run's findings as a portable Markdown or JSON report, the same
shape the CLI and MCP tools produce; turn on **Redact identifiers** first if
the report is headed outside the environment that produced it, since that
pseudonymizes the app id and any host/IP tokens. **Keyboard shortcuts**
(press `?` from anywhere) lists every shortcut. Rounding it out: a **Docs**
link and a theme toggle.

## Compare two runs

To compare a baseline run against a candidate, say to check whether a tuning
change helped, see [Run comparison mode](./run-comparison.md).

## CI and automation

In a pipeline or a script, use the `analyze` CLI instead of the browser
dashboard. It parses the same event logs and exits non-zero when a run
crosses a threshold you set, so it can gate a build:

```sh
npx -p sparkforensics-cli sparkforensics-analyze <file|dir> [--max-runtime ms] [--max-skew ratio] \
  [--max-spill gb] [--max-failed-task-rate pct] [--min-efficiency pct] \
  [--out path]
```

The command ships in the `sparkforensics-cli` package. To install it once:
`npm i -g sparkforensics-cli`, then run `sparkforensics-analyze` directly.

Point it at a single event-log file, or at one run's `eventlog_v2_*`
rolling-log directory; any other directory is rejected. Output goes to
stdout; pass `--out <path>` to write it to that file instead.

Pass `--export-html <dir>` to write a self-contained HTML dashboard for the
run into `<dir>` (which must not already exist or must be empty). Open
`<dir>/index.html` directly in a browser over `file://`, with no server, to
get the same interactive dashboard offline. This makes it easy to archive or
share a run. `--redact` applies to the exported report too.

The CLI also supports fetching a run directly from a reachable Spark History
Server (`--shs-base-url`/`--app-id`/`--attempt-id`) instead of a local file,
comparing a candidate run against a baseline with regression gating
(`--baseline`/`--max-regression-pct`/`--regression-metric`/
`--fail-on-introduced`), redacting the app id and any host/IP tokens before
sharing output (`--redact`), and narrowing the findings to certain impact
bands, types, or a stage (`--impact`/`--type`/`--stage`). Run it with
`--help` for the full flag list.

### Regression metric keys

`--regression-metric` (and the MCP `evaluate_budgets` tool's
`regressionMetric`) takes one of these keys; the default is `wallClock`:

- `wallClock`: wall-clock duration
- `executorRunTime`: summed executor run time
- `shuffleSpill`: shuffle spill
- `diskSpill`: disk spill
- `gcTime`: JVM GC time
- `taskSkew`: p95 task skew
- `failedTaskRate`: failed-task rate

Four more keys, `inputBytes`, `outputBytes`, `taskCount` and
`executorsAdded`, measure workload volume rather than performance. They have
no better or worse direction, so a regression budget on one of them reports
`inconclusive` whenever the value changes, and passes when it doesn't.

Same caveat as above: if the History Server is only reachable through an SSH
bastion, `--shs-base-url` can't reach it either: see
[Alternative ways to get the logs](./alternative-log-retrieval.md).

Running in Airflow instead of a plain CI pipeline? See
[sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator),
an Airflow operator that wraps the CLI and acts on the result after each
Spark job, so you don't have to wire up the call yourself.

Want an AI assistant to diagnose a run directly, without the dashboard or a
CI gate? See [MCP tools reference](./mcp-tools.md).
