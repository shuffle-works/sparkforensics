### `SPEC`: Speculation waste {#spec}

Speculative task attempts used a lot of executor time without confirming a
genuine straggler. Self-flags a confidence that scales with how far the
wasted time sits past the threshold. If task durations are just naturally
variable rather than genuine stragglers, tune
`spark.speculation.multiplier`/`spark.speculation.quantile`.
