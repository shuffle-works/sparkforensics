### `SPEC`: Speculation waste {#spec}

Speculative task attempts used a lot of executor time without confirming a
genuine straggler. Self-flagged low-confidence: a design spike, not yet
validated against real-world runs. If task durations are just naturally
variable rather than genuine stragglers, tune
`spark.speculation.multiplier`/`spark.speculation.quantile`.
