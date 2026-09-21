### `INCMP`: Incomplete run {#incmp}

This event log never recorded an `ApplicationEnd` event: capture stopped
before the run finished (an in-flight job, a rotated-away log, or a
cut-short capture). Every other finding and metric on the board reflects
only what was captured up to that point, not the full run.
