# `get_reference_doc`

Reference for the `get_reference_doc` tool of the SparkForensics MCP server.

Full tuning-reference chapter or bottleneck markdown for one doc anchor
(e.g. `"#joins"`, `"#bottleneck-skew"`, `"#metric-task-duration"`),
independent of any run, so a client without browser access can read the same
reference material the dashboard links to.

Parameters:

- `anchor`: `string` (required): a doc anchor, with or without the leading `#`

Example call:

```json
{ "name": "get_reference_doc", "arguments": { "anchor": "#bottleneck-skew" } }
```

Example response:

```json
{
  "anchor": "bottleneck-skew",
  "title": "Task Skew",
  "content": "# Task Skew\n\n..."
}
```

The returned `anchor` is the owning page's, which can differ from the one you
passed: `"#metric-task-duration"` returns the Metrics Glossary page with
`"anchor": "metrics"`.

An anchor that resolves to no known page returns the `invalid-anchor` error
code (see Errors below).
