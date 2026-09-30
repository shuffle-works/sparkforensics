### `CACHE`: Caching opportunity {#cache}

A reusable dataset (re-read via the same SQL relation more than once, or a
join/union result recomputed by two or more executions, matched by plan
shape) may be worth persisting between stages. Self-flags a confidence that scales with
how many executions reuse the same relation: reuse is only inferred, from
plan-scan identity across SQL executions, so confirm the reads really do
hit the same data before you cache anything.
