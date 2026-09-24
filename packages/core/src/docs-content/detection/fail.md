### `FAIL`: Failed tasks {#fail}

Tasks fail often enough to affect the stage. Failed tasks point to executor
instability or data-driven errors. The finding names the dominant error: the
exception class, or the executor loss reason (for example "Container killed
by YARN for exceeding memory limits"). It lists up to five distinct failures,
each with its message and a short stack excerpt. With redaction on, messages
and the message text inside excerpts are replaced, since they can carry file
paths and data values; class names and stack frames stay.
