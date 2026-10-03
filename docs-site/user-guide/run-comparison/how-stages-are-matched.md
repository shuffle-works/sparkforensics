# How stages are matched

How SparkForensics pairs stages between a baseline and a candidate, and how sure it is about the pairing.

Stage-level detail depends on matching a stage in the baseline to its
counterpart in the candidate, and SparkForensics only does that
automatically when a stage's identity (its position in the SQL plan)
resolves to exactly one match on both sides; AQE's runtime replanning makes
a plain stage-ID match unreliable. The **Per-stage task skew** table covers
only stages matched this way, and the page states what percentage of stages
that was. If matching is uncertain (the two runs have different application names,
or fewer than half their stages matched), a warning banner says so; the metric deltas
above it still hold; they don't depend on stage matching.
