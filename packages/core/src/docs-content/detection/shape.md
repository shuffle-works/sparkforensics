### `SHAPE`: Stage shape {#shape}

The stage has an inefficient task count, output shape (output more than 10×
input), or task-to-stage balance: one straggler task running for more than
half the stage's wall-clock time and over 3× the median task, so it alone
sets when the stage ends. A too-low task count and a straggler are only
flagged on stages that take at least 0.5% of the run.
