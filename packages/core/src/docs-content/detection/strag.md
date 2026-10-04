### `STRAG`: Straggler tasks {#strag}

A few tasks run much slower than the rest of their stage. Rule out a GC
pause or a slow shuffle fetch before assuming a hardware issue. If uneven
data is the cause, the advice is the one a skew finding gives for the same
stage (`evidence.origin`, see `SKEW`): AQE skew-join handling for a shuffle
feeding a join, file sizes for a scan, salting otherwise. Only flagged on
stages that take at least 0.5% of the run.
