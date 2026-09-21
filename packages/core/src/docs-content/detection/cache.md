### `CACHE`: Caching opportunity {#cache}

A reusable dataset (re-read via the same SQL relation more than once) may be
worth persisting between stages. Self-flagged low-confidence: reuse is only
inferred, from plan-scan identity across SQL executions, so confirm the reads
really do hit the same data before you cache anything.
