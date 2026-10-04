# Run comparison mode

Put two runs side by side to see whether a tuning change helped.

## Starting a comparison

From the landing page, click **Compare two runs**. Two slots appear:
**Baseline** and **Candidate**.

1. Load a run into each slot the same way you'd load a single run (drag
   and drop, **Choose file**, **Choose rolling-log folder**, or a History
   Server fetch).
2. Click **Compare**.

The runs parse one after the other through the same background worker. When
both finish, the comparison view opens.

Already looking at a run, for example the one before a change? Click
**Compare with another run** in the top bar (or the **More options** menu on
a phone). The compare view opens with that run as the baseline, so you only
load the candidate, and the open run is not parsed again. **Back to the run** returns to
its dashboard.

## Reading the comparison

The page opens with a verdict: whether the candidate finished faster or
slower than the baseline, and by how much (a change under 2% reads as "about
as long"). When either run had failed jobs, the verdict leads with that
instead, for example "The candidate had 2 of 5 jobs fail (baseline: none)" or
"The candidate's only job failed", and
the run-time line follows. When either log has no end-of-run record (the run
was killed or the log cut off), the verdict says how much run time each log
covers, in a neutral tone, instead of calling the shorter run faster. It then
lists which cost metrics got worse or better in the candidate (again ignoring changes
under 2%), and which finding categories became more or less frequent. Volume and count metrics (input,
output, tasks, executors) are left out, since more or less of them is not
better or worse on its own. **See where to start in the candidate** opens the
candidate's dashboard, whose own verdict names the first thing to fix.

The **Metrics** table covers the whole run: wall-clock duration, memory
spill, task skew, failed-task rate, disk spill, GC time, input/output bytes,
executor run-time, and task/executor counts, baseline against candidate with
the change. **Findings by category** lists which finding types became more or less
frequent in the candidate, per impact level, with the count in each run and the
affected stages.

The **Stages compared** table lists every paired stage with its change in run
time, CPU time, spill (memory and disk together), input, output and shuffle
(read and write together), largest run-time change first. A faster candidate
reads green and a slower one red; input and output are workload volume, so
they stay neutral. Under each stage name sit the pair's quality (`exact`,
`structural` or `aligned`) and its score from 0 to 1. An `aligned` pair was
matched on similarity or position, so treat its change with care.

Select a stage's name to see both runs' figures for it side by side without
leaving the comparison: the stage's name in each run, then duration, run time,
GC time, spill, input, output and task counts with the change. **Open stage N
in the baseline dashboard** and **Open stage N in the candidate dashboard**
open that stage's detail in the run's own dashboard, and **← Back to
comparison** returns here. Below the table, **Re-planned work** lists queries
that ran a different number of stages in the two runs, with the leftover
stages and their total run time per side, and **Unmatched stages** lists
stages that paired with nothing. Both open in the same side-by-side view. The
table shows 25 pairs and reveals more on request.

The table columns read **Baseline** and **Candidate**; hover a column heading
to see the full name of the run.

A banner above the verdict appears when the match is weak. It reads `low` when
under 90% of executor run time sits in paired stages (or the application names
differ), and `insufficient` when neither run recorded any executor run time,
so there is nothing to pair. The banner can be dismissed; every change on the
page is still shown.

How stages are paired, and what the matching confidence means, is in [How stages are matched](./run-comparison/how-stages-are-matched.md).

For everything else, matching is manual: the **Pinned per-stage deltas**
widget lets you pick one stage from the baseline and one from the candidate
yourself and pin the pair, then shows their duration, executor run-time, GC
time, memory/disk spill, input/output bytes, task count, and failed tasks
side by side. Pin as many pairs as you want to check.

For either run's full dashboard, click **View baseline dashboard** or **View
candidate dashboard**. **← Back to comparison** takes you back.

## Comparing without the dashboard

The same comparison runs headlessly, and opens with the same verdict: the
positional run is the candidate, the `--baseline` run the baseline. The CLI's
`--baseline <local file or rolling-log dir>` flag adds the comparison. In JSON
the run's report moves under `candidate` and the comparison sits beside it
under `comparison` (`comparison.verdict` is the headline); in Markdown the
comparison section follows the report. `--baseline` can also gate a build on
the comparison
(`--max-regression-pct`, `--stage-regression-budget`, `--fail-on-introduced`; see [Getting
started](./getting-started/ci-and-automation.md#ci-and-automation)). The MCP server's
`compare_runs` and `evaluate_budgets` tools do the same for an AI assistant;
see [MCP tools reference](./mcp-tools.md).
