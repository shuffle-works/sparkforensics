# Reading the dashboard

How to read the dashboard once a run is loaded, including the advanced view and the rest of the top bar.

When parsing finishes, the dashboard shows a board of widgets, each in its
own card with a title. Every widget that flags a problem uses the same
convention: a colored impact dot (critical / warning / info) and an ALL-CAPS
tag for the bottleneck category (`SKEW`, `SPILL`, `GC`, and so on: see
[Understanding findings](../understanding-findings.md)). Widgets list every
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
which cuts cost but may not shorten the run. A figure "of idle core capacity"
counts allocated cores that ran no task, not work a fix removes. **Copy next steps**
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
`spark.eventLog.logBlockUpdates.enabled=true` for cache storage). If
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

## Advanced view

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

## The rest of the topbar

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
for the other one (see [Run comparison mode](../run-comparison.md)).
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
