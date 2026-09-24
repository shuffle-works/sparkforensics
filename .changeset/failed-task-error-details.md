---
"sparkforensics-web": minor
"sparkforensics-cli": minor
"sparkforensics-mcp": minor
"sparkforensics-server": minor
---

The Failed Tasks (`FAIL`) finding now names the error behind failed tasks instead of only Spark's
end-reason tag: the exception class, or the executor loss reason such as "Container killed by YARN
for exceeding memory limits". A PySpark failure's message is its Python error line (such as
`ValueError: bad row`), not the traceback header. It lists up to five distinct failures, each with its message, loss
reason and one bounded stack excerpt (header, first 8 frames, a Python traceback's error line and the
last `Caused by:` line, at most 2000 characters), plus a count of failed tasks the list leaves out. The finding's `dominantReason`
is unchanged; new evidence fields are `dominantError`, `failureGroups` and `otherFailedTasks`, and
the `failures` detector version is now 2. With `--redact` (and `redact` in the MCP tools), messages
and the message text inside stack excerpts are replaced, since they can carry file paths and data
values; class names, stack frames and loss reasons stay, with hosts pseudonymized as before.
