# `get_finding_documentation`

Reference for the `get_finding_documentation` tool of the SparkForensics MCP server.

Detection and tuning reference documentation for one finding type,
independent of any run: fetch it once per type (not once per finding) and
cache it.

Parameters:

- `type`: `string` (required): a finding `type` value, e.g. `"skew"`, or a
  detector-level type such as `"broadcastSizing"`, which returns the
  documentation of the finding types it emits

Example call:

```json
{ "name": "get_finding_documentation", "arguments": { "type": "skew" } }
```

Example response:

```json
{
  "type": "skew",
  "name": "Task Skew",
  "detectionDoc": {
    "tag": "SKEW",
    "title": "Task skew",
    "content": "### `SKEW`: Task skew {#skew}\n\nA small number of tasks..."
  },
  "tuningDoc": {
    "anchor": "#bottleneck-skew",
    "title": "Task Skew",
    "content": "# Task Skew\n\n..."
  }
}
```

`tuningDoc` is `null` when the finding type has no vendored tuning-doc page.
Two types have none: `configAudit` (its four audited
properties each have their own anchor rather than one shared page, so no
single anchor resolves) and `incompleteRun` (no upstream tuning page covers
this signal at all). A type whose section lives on a general chapter rather
than a bottleneck page (`autoscalingChurn` on Cluster Tuning,
`cacheUtilization` on Memory Management) returns that whole chapter, with
`anchor` naming the section.
