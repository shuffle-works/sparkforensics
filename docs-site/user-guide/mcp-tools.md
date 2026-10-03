# MCP tools reference

SparkForensics has an MCP server with eight tools, so an MCP-aware client (or
an AI agent) can diagnose a run without opening the dashboard.

Five of the eight tools (`list_runs`, `diagnose_run`, `get_run_summary`,
`compare_runs`, `get_finding_evidence`) accept an optional `redact: boolean`
parameter (default `false`) that pseudonymizes the app id and any host/IP
tokens in the response (`app-1`, `host-1`, ...), so a result can be shared
outside the environment that produced it. The app name is as identifying as
the id, so every tool replaces it with the app id's pseudonym. It also
pseudonymizes the value of any field named `host`, and drops the message and
stack text of failed-task errors and the failure reason of a failed stage or job,
which can carry file paths and data values that no pattern recognizes. On
`compare_runs`, `runIdA`/`runIdB` are caller-supplied identifiers, not Spark application ids, so
there's no single app-id field to redact; `redact` instead scans stage names
and other free text for embedded app ids and host/IP tokens and
pseudonymizes those. `list_runs` pseudonymizes every run's app id and name
consistently, so two attempts of the same app still redact to the same
identity across the list.

## Connecting a client

Run the server with `npx`:

```
npx sparkforensics-mcp
```

Or point an MCP client (Claude Desktop, Claude Code) at it with this config:

```json
{
  "mcpServers": {
    "sparkforensics": {
      "command": "npx",
      "args": ["sparkforensics-mcp"]
    }
  }
}
```

To tune detector thresholds, start the server with `--thresholds <file>`
(add `"--thresholds", "/absolute/path/thresholds.json"` to `args`). The file
format is the CLI's: see
[Tuning detector thresholds](./getting-started/tuning-thresholds.md#tuning-detector-thresholds).
The overrides apply to every tool for the life of the server; a client can't
change them per call. An unreadable or invalid file stops the server from
starting: it exits with status 2, with the problem on stderr.
`sparkforensics-mcp --help` prints the usage and the tool list. On a tuned
server, `diagnose_run`, `compare_runs` and `evaluate_budgets` add a top-level `tunedThresholds`, and
each finding and clean check from a tuned detector carries its own
`tunedThresholds`, as in the CLI report. The Markdown output of
`diagnose_run` and `compare_runs` names the tuned thresholds too.

### Connecting over HTTP

The local server (`npx sparkforensics-server`, see
[Run it locally](./getting-started.md#local-server-mode)) also serves the
same eight tools over MCP's streamable HTTP transport at
`http://127.0.0.1:4173/mcp` (or the port you pass with `--port`). Point a
client that speaks streamable HTTP, such as Claude Code, at that URL:

```json
{
  "mcpServers": {
    "sparkforensics": { "type": "http", "url": "http://127.0.0.1:4173/mcp" }
  }
}
```

It is for clients on the same machine only. The server listens on
127.0.0.1, and a request whose `Host` header isn't `127.0.0.1:<port>` or
`localhost:<port>` gets a 403, which blocks DNS-rebinding attacks from web
pages. Use `127.0.0.1` in the URL: `localhost` can resolve to the IPv6
address `::1`, where the server doesn't listen.

The endpoint always runs the default detector thresholds: the server takes
no `--thresholds` flag. To tune thresholds, run `sparkforensics-mcp` over
stdio instead. Runs are cached in the server process as they are for
`sparkforensics-mcp`, so a `runId` from one request works in later ones
until it expires. A relative `source.path` resolves against the directory
you started the server from. The examples below use short relative names;
pass an absolute path when in doubt.

## Errors

Errors a tool raises carry `structuredContent.code`, the same way in all
eight tools:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "<error message>" }],
  "structuredContent": { "code": "<error-code>" }
}
```

Arguments that fail the input schema (a wrong type, a missing required
field, both `dir` and `shsBaseUrl`, `maxResults` below 1) return
`isError: true` with the text `MCP error -32602: Input validation error: ...`
and no `structuredContent`.

The codes:

- `run-not-found`: no cached run for the `runId` you passed.
- `finding-not-found`: that `findingId` isn't on that run.
- `invalid-date-filter`: `list_runs`'s `minDate` or `maxDate` isn't a
  parseable date.
- `invalid-type`: that finding `type` isn't one `get_finding_documentation` recognizes.
- `invalid-anchor`: that `anchor` doesn't resolve to a known `get_reference_doc` page.
- `invalid-event-log`: the file doesn't exist, the file isn't a decodable
  event log, the folder isn't a rolling event-log directory, or the History
  Server archive couldn't be decoded.
- `application-not-found`: the History Server returned a 404 for that
  `appId`/`attemptId`.
- `upstream-unreachable`: loading a run from the History Server failed
  because the server couldn't be reached (connection refused, DNS failure),
  didn't send headers in time, or stalled mid-body. `list_runs` reports it
  when the server can't be reached or doesn't answer in time.
  `SPARKFORENSICS_SHS_TIMEOUT_MS` (default 30000) sets these timeouts. If the
  server is unreachable entirely (an SSH-only cluster), see
  [Behind an SSH bastion](./alternative-log-retrieval/ssh-bastion.md#behind-an-ssh-bastion).
- `archive-too-large`: the History Server archive blew the byte cap (1 GiB
  by default). Override it with `SPARKFORENSICS_MAX_ARCHIVE_BYTES`.
- `directory-not-found`: `list_runs`'s `dir` doesn't exist, isn't a
  directory, or isn't readable.
- `invalid-shs-base-url`: `list_runs`'s `shsBaseUrl` isn't an absolute
  HTTP(S) URL without credentials, query, or fragment.
- `access-or-upstream-failure`: the fallback code. Bad parameters, a failed
  History Server fetch, or any error that carries no more specific code.
  Common causes: neither `source` nor `runId` given, neither `dir` nor
  `shsBaseUrl` given, `regressionMetric` without `maxRegressionPct`, and a
  `source` whose `shsBaseUrl` or `appId` isn't valid.
