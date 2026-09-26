# Run comparison mode

Put two runs side by side to see whether a tuning change helped.

## Starting a comparison

From the landing page, click **Compare two runs**. Two slots appear: **Run
A (baseline)** and **Run B (candidate)**.

1. Load a file into each slot the same way you'd load a single run (drag
   and drop, or **Choose file**).
2. Click **Compare**.

The runs parse one after the other through the same background worker. When
both finish, the comparison view opens.

Already looking at a run, for example the one before a change? Click
**Compare with another run** in the top bar (or the **More options** menu on
a phone). The compare view opens with that run as Run A, so you only load
Run B, and the open run is not parsed again. **Back to the run** returns to
its dashboard.

## Reading the comparison

The page opens with a verdict: whether run B finished faster or slower than
run A, and by how much (a change under 2% reads as "about as long"). When
either run had failed jobs, the verdict leads with that instead, for example
"Run B had 2 of 5 jobs fail (run A: none)", and the run-time line follows. It then
lists which cost metrics got worse or better in run B (again ignoring changes
under 2%), and which finding categories became more or less frequent. Volume and count metrics (input,
output, tasks, executors) are left out, since more or less of them is not
better or worse on its own. **See where to start in run B** opens run B's
dashboard, whose own verdict names the first thing to fix.

The **Metrics** table covers the whole run: wall-clock duration, shuffle
spill, task skew, failed-task rate, disk spill, GC time, input/output bytes,
executor run-time, and task/executor counts, baseline against candidate with
the change. **Findings by category** lists which finding types appeared or
disappeared between the two runs, with the affected stages for each.

Stage-level detail depends on matching a stage in the baseline to its
counterpart in the candidate, and SparkForensics only does that
automatically when a stage's identity (its position in the SQL plan)
resolves to exactly one match on both sides; AQE's runtime replanning makes
a plain stage-ID match unreliable. The **Per-stage task skew** table covers
only stages matched this way, and the page states what percentage of stages
that was. If matching is uncertain (for example, the two runs came from
different application names), a warning banner says so; the metric deltas
above it still hold; they don't depend on stage matching.

For everything else, matching is manual: the **Pinned per-stage deltas**
widget lets you pick one stage from the baseline and one from the candidate
yourself and pin the pair, then shows their duration, executor run-time, GC
time, memory/disk spill, input/output bytes, task count, and failed tasks
side by side. Pin as many pairs as you want to check.

For either run's full dashboard, click **View run A dashboard** or **View
run B dashboard**. **← Back to comparison** takes you back.

## Comparing without the dashboard

The same comparison runs headlessly. The CLI's `--baseline` flag adds a
comparison section to its output and can gate a build on it
(`--max-regression-pct`, `--fail-on-introduced`; see [Getting
started](./getting-started.md#ci-and-automation)). The MCP server's
`compare_runs` and `evaluate_budgets` tools do the same for an AI assistant;
see [MCP tools reference](./mcp-tools.md).
