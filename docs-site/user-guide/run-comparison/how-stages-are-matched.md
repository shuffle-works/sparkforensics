# How stages are matched

How SparkForensics pairs stages between a baseline and a candidate, and how sure it is about the pairing.

Stage-level detail depends on pairing a stage in the baseline with its
counterpart in the candidate. A stage ID is no help: AQE's runtime replanning
and a different submission order change it from run to run. So a stage is
identified by what it ran: its normalized name plus the plan nodes its tasks
were attributed to.

Before two stages are compared, the text that differs between two runs of the
same job is rewritten to a fixed form:

- random per-run staging directories in paths (a 6-8 character segment that
  mixes cases, or letters with digits: a real directory named `output01` is
  rewritten too)
- dates and timestamps, such as the run date in a predicate
- `IN` and `INSET` lists, which grow with the processing window
- file counts in a file index, such as `DeltaLogFileIndex(4 paths)`

Numbers, paths and string literals in general are not rewritten: two stages that
differ in a filter constant or an input path stay different stages. The order of
a column list is not normalized either, so a grouping set that a program emits in
a different order each time can leave those stages unpaired. Text that
is specific to your runs, such as an output directory that includes the run's
variant name, can be rewritten with the CLI's `--normalize-path` flag or the
MCP `compare_runs` tool's `normalizePath` parameter. Despite the name it is a
generic regular expression, not only for paths, and it affects only which
stages pair, never the findings.

Stages that share an identity pair off in stage-ID order when each run has the
same number of them. A different number on each side (a loop that ran 14 times
in one run and 15 in the other) leaves them all unpaired.

Stages that only read the Delta transaction log or its checkpoints are table
bookkeeping, not query work. They are listed apart from the pairs and counted
in neither the pairs, the unmatched stages nor the coverage.

## Runtime coverage and confidence

The comparison reports the **runtime coverage**: the share of both runs'
executor run time that sits in paired stages, with every task attempt counted
(failed and speculative ones too). It is weighted by run time, not stage count,
because a few unmatched heavy stages matter more than many matched small ones.
The share of stages matched, by count, is reported too (`matchedCoverage`) and
does not decide the confidence.

The confidence is:

- `ok` when the runs have the same application name and the runtime coverage is
  at least 90%.
- `low` when the application names differ, or the runtime coverage is under 90%.
  A warning banner says which, for example "Only 62% of executor run time is in
  matched stages, so per-stage rows mostly compare unrelated work". The metric
  deltas above it still hold: they do not depend on stage pairing.
- `insufficient` when neither run recorded any executor run time, so there is no
  work to compare. The banner says so.

The **Per-stage task skew** table lists only paired stages, and the page states
the share of executor run time they hold. Confidence does not change the exit
code of a CLI budget.
