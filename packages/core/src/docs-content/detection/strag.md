### `STRAG`: Straggler tasks {#strag}

A few tasks run much slower than the rest of their stage. Rule out a GC
pause or a slow shuffle fetch before assuming a hardware issue; if a skewed
key is the real cause, that's a candidate for AQE's skew-join handling. Only
flagged on stages that take at least 0.5% of the run.
