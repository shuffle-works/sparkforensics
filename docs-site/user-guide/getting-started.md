# Getting started

SparkForensics reads a Spark History Server event log and turns it into a
dashboard of flagged bottlenecks. No server or account required.

## Load a run

Drop a log file onto the landing page, or click **Choose file** to pick one.
Parsing runs in a background worker, off the browser's main thread, so a
multi-hundred-megabyte event stream doesn't freeze the tab.

No log of your own yet? Click **Try a sample run** on the landing page to
load a bundled example run and see a populated dashboard right away.

The app takes a newline-delimited JSON event log (one JSON event per line,
the format Spark writes to `spark.eventLog.dir`), either plain or
gzip/Zstandard/LZ4/Snappy-compressed.

The same landing page has two other ways in: **Choose rolling-log folder**
for an `eventlog_v2_*` rolling directory, and **Fetch from Spark History
Server** to pull an application from a reachable History Server
(local-server mode only).

Can't reach the History Server directly (it's only reachable through an SSH
bastion)? See [Alternative ways to get the logs](./alternative-log-retrieval).

A History Server export needs one manual step. `GET
/api/v1/applications/<appId>/logs` hands back a zip, and the drop zone does
not unwrap zip containers. Extract the `.zstd` event log from that zip
yourself and drop the extracted file in. It needs no further decompressing.

Files you have already loaded stay listed under **Recent files** on the
landing page.

## Reading the dashboard

When parsing finishes, the dashboard shows a board of widgets, each in its
own card with a title. Every widget that flags a problem uses the same
convention: a colored impact dot (critical / warning / info) and an ALL-CAPS
tag for the bottleneck category (`SKEW`, `SPILL`, `GC`, and so on: see
[Understanding findings](./understanding-findings)). Widgets list every
affected stage, not just the worst one. The dot's color tracks how much run
time the finding could save you rather than how unusual the metric looks, so
a small-looking anomaly with a big payoff can outrank a dramatic one that
would barely move your run time.

A run scorecard (wall-clock, efficiency, wastage) always shows at the top.
Below it, two tabs split the rest of the board:

1. **Findings**: every flagged finding and its detail widget, grouped by
   impact band (Critical, Warning, Info). Within a band, a recommendation row
   for a bottleneck type collapses into a summary row when it fires more than
   once; clicking the summary row expands its full list, and clicking any
   single row or widget jumps straight to that finding. Below the impact-band
   groups, memory and core-usage utilization always show, even on a clean
   run, and widgets that found nothing fold away into a "Clean checks"
   disclosure. This is the tab you land on.
2. **Full app report**: the wall-clock and executor timelines, the stage
   table, and the reference-only cards.

### Advanced view

The topbar has an **Advanced view** toggle. It's off by default, which keeps
each widget to the finding itself and what to do about it. Turn it on to also
show confidence levels, supporting evidence, and documentation links for each
finding, plus a few extra table columns. Your choice is remembered across
runs.

The topbar also carries a **New analysis** button (back to the landing page
to load another run) and a **Docs** link, both available once a run is
loaded.

## Compare two runs

To compare a baseline run against a candidate, say to check whether a tuning
change helped, see [Run comparison mode](./run-comparison).

## CI and automation

In a pipeline or a script, use the `analyze` CLI instead of the browser
dashboard. It parses the same event logs and exits non-zero when a run
crosses a threshold you set, so it can gate a build:

```sh
npx sparkforensics-analyze <file|dir> [--max-runtime ms] [--max-skew ratio] \
  [--max-spill gb] [--max-failed-task-rate pct] [--min-efficiency pct] \
  [--out path]
```

Point it at a single event log or a directory of them. Pass `--out` to also
write the findings to a file.

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

Same caveat as above: if the History Server is only reachable through an SSH
bastion, `--shs-base-url` can't reach it either: see
[Alternative ways to get the logs](./alternative-log-retrieval).

Running in Airflow instead of a plain CI pipeline? See
[sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator),
an Airflow operator that wraps the CLI and acts on the result after each
Spark job, so you don't have to wire up the call yourself.
