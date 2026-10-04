# How stages are matched

How SparkForensics pairs stages between a baseline and a candidate, and how sure it is about the pairing.

Stage-level detail depends on pairing a stage in the baseline with its
counterpart in the candidate. A stage ID is no help: AQE's runtime replanning
and a different submission order change it from run to run. So a stage is
identified by what it ran, and pairing happens in two levels: first the SQL
executions of the two runs line up, then the stages inside each pair of
executions.

## Text that differs between runs

Before two stages are compared, the text that differs between two runs of the
same job is rewritten to a fixed form:

- random per-run staging directories in paths (a 6-8 character segment that
  mixes cases, or letters with digits: a real directory named `output01` is
  rewritten too)
- dates and timestamps, such as the run date in a predicate
- `IN` and `INSET` lists, which grow with the processing window
- file counts in a file index, such as `DeltaLogFileIndex(4 paths)`

Numbers, paths and string literals in general are not rewritten: two stages that
differ in a filter constant or an input path have different exact keys (see
below). Text that is specific to your runs, such as an output directory that
includes the run's variant name, can be rewritten with the CLI's
`--normalize-path` flag or the MCP `compare_runs` tool's `normalizePath`
parameter. Despite the name it is a generic regular expression, not only for
paths, and it affects only which stages pair, never the findings.

## Level one: SQL executions

Each run's SQL executions are laid out in submission order and aligned with an
order-preserving sequence alignment (a longest-common-subsequence dynamic
program). An execution pair scores on three things: the call site (the
user-code frames in the stages' stack traces), the description, and the plan
structure (operator names and the attribute names the plan mentions). A part
one side lacks drops out of the score, which matters for PySpark, where every
call site is generic. Only pairs scoring at least 0.55 can match, and of equal
alignments the one that keeps the lower execution IDs wins, so the result is
deterministic and swapping baseline and candidate mirrors it (except when two
crossing alignments tie exactly, where the answer depends on which run is the
baseline).

A loop of identical queries that ran 14 times in one run and 15 in the other
pairs 14 iterations and leaves the extra iteration unmatched.

Stages outside any SQL execution (RDD jobs, for example) form one
pseudo-execution per run, paired with each other and matched on stage name and
call-site text.

The alignment needs at least half of both runs' executions to pair
(`2 * paired / (baseline executions + candidate executions)` is at least 0.5).
Below that the two runs are not treated as one job and no stage pairs: stages as
generic as a `count` or a `collect` repeat across unrelated jobs, and only the
executions around them tell the jobs apart. The comparison reports the counts
and the ratio as `executionAlignment`.

### Cost

The full alignment compares every baseline execution with every candidate
execution. Up to 1,000,000 such pairs (1,000 by 1,000 executions) it runs in
full. Beyond that it is restricted to a band around the diagonal, about
`2 * (100 + |n - m| / 2) + 1` candidates per baseline execution, so the work
grows with the number of executions, not its square. A comparison that used the
band reports `executionAlignment.bounded: true`. An insertion or deletion run
inside the band is found; one that shifts the two runs further apart than the
band is not, and the executions it separates stay unmatched.

## Level two: stages inside an execution pair

Every stage has two keys. The **exact key** is its normalized name plus the
fingerprint of the plan nodes its tasks were attributed to (normalized node
text). The **structural key** is the shape of those nodes: the operator tree,
node names and the sorted attribute names each node mentions, with literals,
paths, file counts and ids left out. A grouping set that a program emits in a
different column order each time has one structural key.

Inside an aligned execution pair, stages pair in this order, and a stage pairs
at most once:

1. **`exact`**: the same exact key. Stages that share a key pair off in
   stage-ID order, as many as both sides have. A self-join subtree that ran 3
   times in one run and 2 in the other pairs 2.
2. **`structural`**: the same structural key, different text.
3. **`aligned`**: different structure, but the text (stage name and normalized
   node text, compared as sets of tokens) is at least 60% similar. The best
   scoring pairs go first.
4. **`aligned`**, by position: stages with no attributed plan nodes pair by
   position among the stages of the same name inside their execution. These
   pairs have the score 0.5, since no plan evidence backs them.

`score` is 1 for an exact pair, the text similarity for a structural or aligned
one, and 0.5 for a pair made by position. A caller that wants only pairs it can
trust reads `quality`.

## Re-planned executions

A configuration change can make Spark plan an execution differently: a broadcast
join takes out an exchange, so the two sides run different numbers of stages.
When an aligned execution pair has different stage counts (Delta bookkeeping
stages excluded), the stages left unpaired on either side are reported together
in `replanned`, with both execution IDs, the leftover stage IDs per side and the
total of each delta metric per side. Stages that did pair keep their pair. When
the stage counts are equal, leftover stages are `unmatched` instead: the same
number of stages with no pairing point at changed work, not at a re-plan. The
stages outside any SQL execution have no plan to re-plan, so their leftovers
are `unmatched`.

Stages that only read the Delta transaction log or its checkpoints are table
bookkeeping, not query work. They are listed apart from the pairs and counted
in neither the pairs, the unmatched stages, the replanned stages nor the
coverage.

## Runtime coverage and confidence

The comparison reports the **runtime coverage**: the share of both runs'
executor run time that sits in paired or replanned stages, with every task
attempt counted (failed and speculative ones too). It is weighted by run time, not stage count,
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

Replanned run time counts toward the coverage because the two sides of a
replanned group still ran the same execution, and the group reports comparable
totals. A group shows how much run time it holds, so a coverage made mostly of
replanned work is visible in `replanned`.

The **Per-stage task skew** table lists only paired stages, and the page states
the share of executor run time they hold. Confidence does not change the exit
code of a CLI budget.
