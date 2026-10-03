# `list_runs`

Reference for the `list_runs` tool of the SparkForensics MCP server.

List candidate Spark event-log runs from a local directory or a Spark
History Server, before diagnosing one with the tools above. Local-mode
scanning is non-recursive: only the files and rolling-log subdirectories
directly inside `dir` are considered. Runs are listed newest first.

Parameters:

- `dir` (string, local mode) or `shsBaseUrl` (string, SHS mode): exactly
  one of the two. Passing both fails input validation; passing neither
  returns `access-or-upstream-failure`.
- `namePattern` (string, optional): case-insensitive substring match against
  each run's name.
- `minDate`/`maxDate` (string, optional): filter by start time. A value
  that doesn't parse as a date fails with `invalid-date-filter`. In History
  Server mode the dates are also sent to the server, which may reject an
  unparseable value first (`access-or-upstream-failure`).
- `maxResults` (number, optional, default 100): caps the number of runs
  returned; when more candidates matched, `truncated` is `true`.
- `redact` (boolean, optional, default `false`): pseudonymizes every run's
  app id, name and `source` (see the note at the top of this page).

Example call:

```json
{ "name": "list_runs", "arguments": { "dir": "/var/log/spark-events" } }
```

Example response:

```json
{
  "runs": [
    {
      "appId": "application_1700000000000_0001",
      "name": "MyApp",
      "sparkVersion": "3.5.0",
      "startTime": "2026-01-01T12:00:00.000Z",
      "source": { "path": "/var/log/spark-events/application_1700000000000_0001" }
    }
  ],
  "truncated": false
}
```

Each entry's `source` is the same shape `diagnose_run`/`get_run_summary`
accept as `source`, so a result row can be passed straight into those tools
without re-deriving anything, unless `redact` is on: redaction replaces
`source.path` (or `source.appId`) with the pseudonym, so a redacted row can't
be loaded. A row can also carry `durationMs` (History Server mode only) and
`source.attemptId`.
