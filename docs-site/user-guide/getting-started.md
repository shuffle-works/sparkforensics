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
load a bundled example run and see a populated dashboard right away. A line
above its verdict says it is the sample, with **Load my event log** and a
link to where to find one, so you can switch to your own run from there. **Where
do I find my event log?**, under the buttons, is a short guide to turning
event logging on and downloading a log from a History Server.

The app takes a newline-delimited JSON event log (one JSON event per line,
the format Spark writes to `spark.eventLog.dir`), either plain or
gzip/Zstandard/LZ4/Snappy-compressed. It also takes the zip a Spark History
Server hands back, from the Spark UI's download link or from `GET
/api/v1/applications/<appId>/logs`, as-is: drop the `.zip` and the app
unwraps the log inside it, or reassembles the parts of a rolling log. The zip
must hold one attempt: for an application that ran more than once, download
`/api/v1/applications/<appId>/<attemptId>/logs` instead. Spark's `lzf` codec
is not supported: set `spark.eventLog.compression.codec` to `zstd`, `lz4` or
`snappy`.

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
bastion)? See [Behind an SSH bastion](./alternative-log-retrieval.md#behind-an-ssh-bastion).

In Chromium-based browsers, single files you open stay listed under
**Recent files** on the landing page. Rolling-log folders, History Server
fetches and the sample run are not listed.

## Reading the dashboard

When parsing finishes, the dashboard shows a board of widgets, each in its
own card with a title. Every widget that flags a problem uses the same
convention: a colored impact dot (critical / warning / info) and an ALL-CAPS
tag for the bottleneck category (`SKEW`, `SPILL`, `GC`, and so on: see
[Understanding findings](./understanding-findings.md)). Widgets list every
affected stage, not just the worst one. For a finding with a run-time
estimate, the dot's color tracks how much run time it could save rather than
how unusual the metric looks, so a small-looking anomaly with a big payoff can
outrank a dramatic one that would barely move your run time. A finding with
only a resource estimate, or none, keeps the level its check assigned.

The board opens with a verdict: one line saying where to start, a short
summary of what was found, and up to three numbered next steps. Each step
says what the finding measured and what to try, and has a
**Show evidence** button that jumps to the finding's detail widget. Findings
on the same stage are folded into one step, because they usually share a
cause and their savings overlap rather than add up. Each savings figure says
what it counts: a time such as "58.6s of run time" is how much sooner the run
could finish, while a resource figure such as "3.0 GB-h of unused executor
memory" or "0.7 core-h of core time" is cluster time a fix would free up,
which cuts cost but may not shorten the run. **Copy next steps**
copies the whole plan as a plain checklist (run, verdict, and numbered steps
with their stage and savings) to paste into a ticket or a message. Steps
follow the same savings ranking as the rest of the board. When much of the
run's executor capacity sat idle, the summary says so, without moving
cluster size ahead of a bigger fix.

The verdict also says how the run ended. When every job succeeded it says
so. When a job failed, the title says the run failed (or how many of its
jobs did), quotes the first line of the reason Spark recorded, and puts the
failure first in the next steps, ahead of any speed-up, since a job has to
finish before its speed matters.

A run is called clean only when the log had everything its checks need.
When something was missing, the run is never called clean: the Findings
tab's **Clean checks** list says which checks could not run and, where Spark
has one, the setting to turn on for the next run (for example
`spark.eventLog.logStageExecutorMetrics=true` for per-executor memory). If
nothing else was found, the verdict title says so too.

A run scorecard sits under the verdict: **Wall-clock** (total run time),
**Efficiency** (the share of that time with a stage running; higher is
better; **Not measured** when no stage in the log recorded an end) and **Unused core time** (the share of executor core time that ran no task,
the same idle figure a verdict step reports; lower is better). When the log
has no complete application timing, one **Timing unavailable** notice
replaces the three tiles. A collapsed **New to Spark tuning?** primer in the verdict
explains stages, tasks, executors, shuffle and how to read savings. Stage
labels such as **Stage 7** open that stage's details: how long it ran and
what share of the run that was, then each of its findings with what it
measured, what to try and a **Show evidence** button, followed by its
overview, task, locality, I/O, spill, GC and plan sections (spill and GC only
when the stage had them).
Below it, two tabs split the rest of the board:

1. **Findings**: every flagged finding and its detail widget, grouped by
   impact band (Critical, Warning, Info). Within a band, a recommendation row
   for a bottleneck type collapses into a summary row when it fires more than
   once; clicking the summary row expands its full list, and clicking any
   single row or widget jumps straight to that finding. Each band leads with
   its recommendation rows; its detail widgets (the charts and per-stage
   numbers behind them) sit under **Show the evidence**, and **Show
   evidence** on any finding opens them for you. Advanced view shows the
   widgets without that step. Widgets that found nothing fold away into a "Clean checks"
   disclosure. A check the log lacked the data for is listed there under
   **Not checked on this log**, not as a pass, with the reason and the
   setting to turn on: for example every per-stage check when no stage
   finished, or core usage, memory and executor churn when the log has no
   end-of-run record. This is the tab you land on.
2. **Full app report**: the wall-clock and executor timelines, the stage
   table, and the reference-only cards, led by core usage by locality, which
   shows even on a clean run.

Click a finding's tag to open its reference material in a slide-in panel
beside the dashboard: the dashboard stays visible and interactive, so you can
check a metric against the reference without losing your place. Esc closes
the panel, even while you are reading or scrolling inside it. The topbar's
**Docs** button opens these docs in a new tab.

### Advanced view

The topbar has an **Advanced view** toggle. It's off by default, which keeps
each widget to the finding itself and what to do about it. Turn it on to also
show confidence levels, supporting evidence, and a page icon beside each
finding's tag that opens its entry in these docs, plus a few extra table columns and the finding filter bar (impact,
type, stage). A filter that is already active, for example from a shared
link, keeps the filter bar visible either way. In the verdict, each step
also says how its savings figure was estimated (measured or modeled, and
whether the stage ran alone or shared the cluster, which makes the figure a
range from a floor to an optimistic high), shows any confidence marker, and
a line states how the steps are ordered. The scorecard switches from
plain captions to the raw run and idle-time breakdown, and the newcomer
primer is hidden. Advanced view also turns on single-key triage shortcuts:
`j` and `k` step through the verdict's steps and then every finding row,
`Enter` shows the focused finding's evidence, or expands a grouped finding,
`f` jumps to the filters, and
`1` and `2` switch between **Findings** and **Full app report**. They stay
off in the default view, so they never surprise a first-time visitor or a
screen-reader user. Your choice is remembered across runs.

### The rest of the topbar

Once a run is loaded, the topbar also carries a few more controls. The run
name opens a menu of recent files, to switch to another run or load a new
file. When the parser skipped malformed lines, a warning beside the name
says how many. The count chip ("4 critical") counts the same findings the
verdict ranks; click
it to jump to that band of the Findings list (a board filter hiding the band
is cleared, with a notice saying so). It reads **Run failed** when a job
failed and there is no finding to count, **No findings** only when the
verdict calls the run clean, and **Not fully checked** otherwise. For
keyboard users, the first Tab stop is **Skip to the verdict**.
**New analysis** goes back to the landing page to load another run;
dropping a file onto the dashboard loads it too.
**Compare with another run** keeps this run as the baseline and asks only
for the other one (see [Run comparison mode](./run-comparison.md)).
**Plan graph** opens an interactive node-and-edge view of the run's SQL
execution plan, filterable down to I/O operators (scan, exchange), a
broader "basic" set, or every operator. **Export evidence** downloads the
current run's findings as a portable Markdown or JSON report, the same
report the CLI produces, or as **Download HTML dashboard**: one
`.html` file holding this dashboard for the run, which opens in any browser
with no server, like the CLI's `--export-html` folder. Exported dashboards
carry no docs links: finding tags and "learn more" references show as plain
text, so look them up in these docs yourself. An exported dashboard shows the
conclusions worked out when it was exported, and its footer names the tool,
core version and build that produced it; it has no **Export evidence** menu of
its own. A file written by an incompatible
release opens to a message saying so; export the run again with your current
release. Turn on
**Redact identifiers** first if the export is headed outside the environment
that produced it, since that pseudonymizes the app id, the app name and any
host/IP tokens in all three formats. **Keyboard shortcuts**
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

Output is JSON by default; `--format md` writes the Markdown report instead.
Budget violations and inconclusive budgets print to stderr as
`[violation] ...` and `[inconclusive] ...` lines. The exit code is 0 when
every budget passes, 1 when one is violated, 3 when none is violated but one
is inconclusive, 2 for a usage error (bad flags or arguments, an invalid
`--thresholds` or `--budgets` file), 4 when the candidate log can't be read or
parsed or its History Server fetch fails, 5 when the `--baseline` log can't be
read or parsed, and 6 for an internal error, including a failed `--export-html`.
When several of these apply, the worst wins in this order: 6, 5, 4, 1, 3, 0.
A usage error exits 2 before any log is read.

`--min-efficiency` checks busy core time, the share of executor core time that
ran tasks (100 minus the dashboard's Unused core time). It is not the
dashboard's Efficiency tile, which is the share of wall-clock with a stage
running, so the two can differ widely on the same run.

The command ships in the `sparkforensics-cli` package. To install it once:
`npm i -g sparkforensics-cli`, then run `sparkforensics-analyze` directly.
`npx sparkforensics-analyze <file>` is a shorter way to run the same command.

Point it at a single event-log file, or at one run's `eventlog_v2_*`
rolling-log directory; any other directory is rejected. Output goes to
stdout; pass `--out <path>` to write it to that file instead.

Pass `--export-html <dir>` to write a self-contained HTML dashboard for the
run into `<dir>` (which must not already exist or must be empty). Open
`<dir>/index.html` directly in a browser over `file://`, with no server, to
get the same interactive dashboard offline, without the docs links. This
makes it easy to archive or share a run. `--redact` applies to the exported
report too.

The CLI also supports fetching a run directly from a reachable Spark History
Server (`--shs-base-url`/`--app-id`/`--attempt-id`) instead of a local file,
comparing a candidate run against a baseline with regression gating
(`--baseline`/`--max-regression-pct`/`--regression-metric`/
`--fail-on-introduced`; the baseline is a local file or rolling-log
directory, no History Server), several regression budgets and several
candidates in one call (`--regression-budget`/`--budgets`, see
[Several budgets and several candidates](#several-budgets-and-several-candidates)), redacting the app id, the app name and any host/IP
tokens before sharing output (`--redact`), and narrowing the findings to certain impact
bands, types, or a stage (`--impact`/`--type`/`--stage`), and tuning
detector thresholds from a file (`--thresholds`, below). Run it with
`--help` for the full flag list.

Same caveat as above: if the History Server is only reachable through an SSH
bastion, `--shs-base-url` can't reach it either: see
[Behind an SSH bastion](./alternative-log-retrieval.md#behind-an-ssh-bastion).

Running in Airflow instead of a plain CI pipeline? See
[sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator),
an Airflow operator that wraps the CLI and acts on the result after each
Spark job, so you don't have to wire up the call yourself.

Want an AI assistant to diagnose a run directly, without the dashboard or a
CI gate? See [MCP tools reference](./mcp-tools.md).

### Tuning detector thresholds

Every check fires at a fixed default threshold. When your normal workload
trips one on purpose, such as a join you skew deliberately, pass
`--thresholds <file>` to run that check with your own value. The file is
JSON, keyed by detector, then by threshold name:

```json
{
  "skew": { "ratioWarn": 6 },
  "shuffle": { "minBytes": 1073741824 }
}
```

The names, units and defaults are the `detectors` catalog in the CLI's JSON
report (`thresholds` on each row): bytes are raw byte counts, times are
milliseconds, and `*Pct`/`*Rate` values are fractions (`0.05` is 5%). A tier
list such as `slowHost.ratioTiers` takes the same number of values, in
ascending order. The `configAudit` checks can't be tuned: they compare your
Spark settings against Spark's own defaults.

The CLI refuses to run, with exit code 2 and a message naming the problem,
when the file can't be read, isn't valid JSON, or names an unknown detector
or threshold, or a value of the wrong shape. It never falls back to the
defaults silently.

A tuned run says so wherever it reports:

- Each finding from a tuned detector carries `tunedThresholds` (each
  overridden threshold's `value` and `default`), and its `validationRequired`
  text names them and, when the finding has an impact estimate, says that
  estimate is unvalidated. The estimates are calibrated
  against the default thresholds, so they were never checked for a finding
  your override lets through. Tuning `slowHost` also labels `stageSlowness`
  findings (as `slowHost.<name>`), because a slow host hides a stage's
  slowness finding, so the override decides which of those you see.
- A clean check measured against a tuned threshold carries
  `tunedThresholds` too, with the tuned value and the default. Its
  `thresholdSummary` shows the tuned numbers for most detectors (for example
  `skew`, `gc`, `spill`, `slowHost`). A few summaries are fixed text with no
  number to tune.
- `summary.tunedThresholds` lists every tuned detector, and each tuned row
  of the `detectors` catalog shows the thresholds the run used.
- The Markdown report adds a `Tuned thresholds` line to its header and a
  `tuned thresholds` line to each affected finding.

An override equal to the default changes nothing and is not labeled.
`--baseline` runs the baseline with the same overrides, so the comparison
compares like with like. The budget flags are separate gates computed from
the run's own figures; the one that recomputes a detector's figure,
`--max-skew`, uses the file's `skew.minTasksForP95`, so it measures the
same ratio the skew finding reports. `--export-html` writes the dashboard
with the default thresholds, because the dashboard never tunes, and prints
a note to stderr saying so. The browser dashboard has no tuning.

### Regression metric keys

`--regression-metric`, `--regression-budget` and the `--budgets` file (and the
MCP `evaluate_budgets` tool's `regressionMetric`) take one of these keys; the
default for `--regression-metric` is `wallClock`:

- `wallClock`: wall-clock duration
- `executorRunTime`: summed executor run time
- `shuffleSpill`: memory spill (Spark's `memoryBytesSpilled`)
- `diskSpill`: disk spill (Spark's `diskBytesSpilled`)
- `gcTime`: JVM GC time
- `taskSkew`: p95 task skew
- `failedTaskRate`: failed-task rate

Four more keys, `inputBytes`, `outputBytes`, `taskCount` and
`executorsAdded`, measure workload volume rather than performance. They have
no better or worse direction, so a regression budget on one of them reports
`inconclusive` whenever the value changes, and passes when it doesn't.

### Several budgets and several candidates

#### Several regression budgets

`--max-regression-pct` checks one metric. To gate on several in one call,
repeat `--regression-budget <metric>:<pct>`, or list them in a file passed
with `--budgets <file>`. Both need `--baseline`, and each budget takes a
[metric key](#regression-metric-keys) and a percentage of zero or more:

```bash
sparkforensics-analyze candidate --baseline baseline \
  --regression-budget wallClock:10 --regression-budget gcTime:25
```

The `--budgets` file is JSON with one key, `regression`, mapping a metric key
to its percentage:

```json
{ "regression": { "wallClock": 10, "gcTime": 25, "failedTaskRate": 0 } }
```

The CLI refuses to run, with exit code 2 and a message naming the problem,
for an unknown top-level key, an unknown metric key, a percentage that is not
a non-negative number (in the file a JSON number, not a string; on the flag
plain digits such as `10` or `2.5`), or a file that can't be read or isn't
valid JSON.

The budgets combine like this:

- `--max-regression-pct` with `--regression-metric` (default `wallClock`)
  still works and counts as one more budget next to the new ones.
- Each metric can be budgeted once across the legacy pair, the repeated flag
  and the file. A metric named twice is a usage error (exit 2), even when both
  give the same percentage.
- Each budget is checked on its own and gives one `max-regression` result
  that carries `metric`, the key it checks. Any violated budget makes the run
  exit `1`; otherwise an inconclusive one makes it exit `3`. A budget on a
  metric the baseline or the candidate log can't provide is inconclusive,
  never a pass.

#### Several candidates

Pass two or more logs as positional arguments, with `--baseline`, to compare
each against the same baseline. The baseline is parsed once. Output is
NDJSON: one line per candidate, in argument order, written as each one
finishes. `--out <path>` writes the lines to a file instead of stdout, and
`--format ndjson` selects this output for a single candidate too. The mode
can't be combined with `--export-html`, `--shs-base-url`, `--format json` or
`--format md` (exit 2). `--redact`, `--thresholds`, `--impact`, `--type`,
`--stage` and every budget flag apply to each candidate.

Each line is one JSON object:

| Field | Meaning |
| --- | --- |
| `log` | The candidate path, as given on the command line. With `--redact`, `candidate-<n>` instead, `n` being the candidate's 1-based position. |
| `status` | `pass`, `violation`, `inconclusive` or `error`. |
| `exitCode` | The exit code this line alone would give: `0` for `pass`, `1` for `violation`, `3` for `inconclusive`, and for `error` `4` (the log can't be read or parsed) or `6` (an internal failure while analyzing it). |
| `error` | The message when `status` is `error`; otherwise `null`. With `--redact`, a generic message that names no path. |
| `budgets` | This candidate's budget results, each with `name`, `status` (`pass`, `violation` or `inconclusive`) and `detail`, plus `metric` on `max-regression`. Empty for an `error` line. |
| `candidate` | The candidate's report, the same object the single-candidate JSON output carries under `candidate`. `null` for an `error` line. |
| `comparison` | `verdict`, `confidence`, `reason`, `matchedCoverage`, `metrics` and `findings`, the same object the single-candidate JSON output carries under `comparison`. `null` for an `error` line. |

A line's `status` follows the single-candidate rules: `violation` if any
budget result is a violation, else `inconclusive` if any is inconclusive
(including the `run-complete` check for a log with no `ApplicationEnd`),
else `pass`.

A candidate that can't be read or parsed doesn't stop the others. Its line
has `status: "error"`, `exitCode: 4`, the message in `error`, and `null` for
`candidate` and `comparison`, as a single-candidate run exits `4` for a
candidate it can't parse. The process exit code is the worst line, in the
order `6`, `5`, `4`, `1`, `3`, `0`, so an unreadable candidate outranks a
violation and a violation outranks an inconclusive result.

Two failures stop the batch before any line is written:

- A usage error (bad flags or arguments, an invalid `--thresholds` or
  `--budgets` file) exits `2`.
- A baseline that can't be read or parsed exits `5`. Fix the baseline and run
  the batch again.

An internal failure that isn't tied to one candidate, such as an unwritable
`--out` path, exits `6`.

With `--redact`, no candidate path is written anywhere, since event-log file
names usually carry the app id. `log` and the `stderr` line prefixes name each
candidate by its 1-based position (`candidate-1`, `candidate-2`, ...), and an
`error` line carries a generic message instead of the parser's, which may
quote the path.
