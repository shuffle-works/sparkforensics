# MCP tools reference

SparkForensics has an MCP server with nine tools, so an MCP-aware client (or
an AI agent) can diagnose a run without opening the dashboard.

| Tool | What it does |
|------|--------------|
| [`list_runs`](./mcp-tools/list-runs.md) | Lists event-log runs in a local directory or on a Spark History Server. |
| [`list_detectors`](./mcp-tools/list-detectors.md) | Lists every finding type the detectors can report, with its tag, family, thresholds, docs and budget flag. |
| [`diagnose_run`](./mcp-tools/diagnose-run.md) | Returns the verdict, the ranked findings and the recommendations for one run. |
| [`get_run_summary`](./mcp-tools/get-run-summary.md) | Returns counts, duration and how the run ended, with no findings. |
| [`compare_runs`](./mcp-tools/compare-runs.md) | Compares a baseline run with a candidate run: verdict, metric deltas and findings delta. |
| [`evaluate_budgets`](./mcp-tools/evaluate-budgets.md) | Checks a run, or a candidate against a baseline, against pass/fail budgets. |
| [`get_finding_evidence`](./mcp-tools/get-finding-evidence.md) | Returns the row of one finding by id. |
| [`get_finding_documentation`](./mcp-tools/get-finding-documentation.md) | Returns the detection and tuning notes for one finding type. |
| [`get_reference_doc`](./mcp-tools/get-reference-doc.md) | Returns one tuning-reference chapter by anchor. |

## Common parameters {#common-parameters}

The tools that load a run (`diagnose_run`, `get_run_summary`, `compare_runs`
and `evaluate_budgets`) take `source` and `runId`. Each tool page lists the
other parameters.

- `source`: where to load a run from. Either `{ path: string }` for a local
  event-log file or rolling-log directory, or
  `{ shsBaseUrl: string, appId: string, attemptId?: string }` for a Spark
  History Server run. `shsBaseUrl` is optional when the server has a default
  History Server (see [Default History Server](#default-history-server)). An `appId` must have one of Spark's id forms
  (`application_<digits>_<digits>`, `local-<digits>`, `app-...`, `spark-...`,
  `driver-<digits>`). A run loaded this way gets a `runId`.
- `runId`: a run already loaded in this server process, as returned by an
  earlier call. Pass `source` or `runId`. When you pass both, `runId` wins.
- `redact`: `boolean`, default `false`. `list_runs`, `diagnose_run`,
  `get_run_summary`, `compare_runs` and `get_finding_evidence` accept it. See
  [Redaction](#redaction).

`compare_runs` takes two runs, so it names them `runIdA`/`sourceA` and
`runIdB`/`sourceB`. `evaluate_budgets` takes `runId`/`source` and an optional
second run as `runIdB`/`sourceB`. `get_finding_evidence` takes a
`runId`, or a `source` with an optional `appId` to load the run again.
`list_runs` returns one `source` per run, in this shape, so a row can be passed
to the other tools.

## Run roles {#run-roles}

The CLI and the two MCP tools that take two runs give the runs different roles:

| Surface | Baseline | Candidate |
|---------|----------|-----------|
| CLI | The `--baseline` run | The positional run |
| `compare_runs` | `runIdA` / `sourceA` | `runIdB` / `sourceB` |
| `evaluate_budgets` with one run | None | `runId` / `source` |
| `evaluate_budgets` with two runs | `runId` / `source` | `runIdB` / `sourceB` |

Absolute budgets and the `run-complete` check apply to the candidate. With
two runs, `evaluate_budgets` returns the `runId` of the first run, the
baseline.

## Redaction {#redaction}

Five of the nine tools (`list_runs`, `diagnose_run`, `get_run_summary`,
`compare_runs`, `get_finding_evidence`) accept an optional `redact: boolean`
parameter (default `false`) that pseudonymizes the app id and any host name or IP
address in the response (`app-1`, `host-1`, ...), including the host of a URL, and
replaces a recognizable user name with `redacted-user`, so a result can be shared
outside the environment that produced it. [What `--redact` covers](getting-started/ci-and-automation.md#what-redact-covers)
lists what is and is not replaced. The app name is as identifying as
the id, so every tool replaces it with the app id's pseudonym. It also
pseudonymizes the value of any field named `host`, and drops the message and
stack text of failed-task errors and the failure reason of a failed stage or job,
which can carry file paths and data values that no pattern recognizes. On
`compare_runs`, `runIdA`/`runIdB` are caller-supplied identifiers, not Spark application ids, so
there's no single app-id field to redact beyond `baselineApp` and `candidateApp`; `redact` instead scans stage names
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

### Default History Server {#default-history-server}

Start the server with `--shs-base-url <url>` (add `"--shs-base-url",
"http://history-server:18080"` to `args`), or set `SPARKFORENSICS_SHS_BASE_URL`,
to give every History Server `source` and `list_runs` call a default.
A call can then pass `{ appId }` alone, or `list_runs` with no arguments. A
`shsBaseUrl` in the call takes precedence, and so does the flag over the
variable. Without a default, `shsBaseUrl` is required.

### Tuning thresholds

To tune detector thresholds, start the server with `--thresholds <file>`
(add `"--thresholds", "/absolute/path/thresholds.json"` to `args`). The file
format is the CLI's: see
[Tuning detector thresholds](./getting-started/tuning-thresholds.md#tuning-detector-thresholds).
The overrides apply to every tool for the life of the server; a client can't
change them per call. An unreadable or invalid file stops the server from
starting: it exits with status 2, with the problem on stderr. An unknown
flag, such as a misspelled `--threshold`, stops it the same way.
`sparkforensics-mcp --help` prints the usage and the tool list. On a tuned
server, `diagnose_run`, `compare_runs` and `evaluate_budgets` add a top-level `tunedThresholds`, and
each finding and clean check from a tuned detector carries its own
`tunedThresholds`, as in the CLI report. The Markdown output of
`diagnose_run` and `compare_runs` names the tuned thresholds too.

### Connecting over HTTP

The local server (`npx sparkforensics-server`, see
[Run it locally](./getting-started.md#local-server-mode)) also serves the
same nine tools over MCP's streamable HTTP transport at
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
nine tools:

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

- `run-not-found`: no cached run for the `runId` you passed, or the `source`
  of `get_finding_evidence` holds another application than its `appId`.
- `invalid-cursor`: the `cursor` of `diagnose_run` does not match this call.
- `finding-not-found`: that `findingId` isn't on that run.
- `invalid-date-filter`: `list_runs`'s `minDate` or `maxDate` isn't a
  parseable date.
- `invalid-type`: that finding `type` isn't one `get_finding_documentation` recognizes.
- `invalid-anchor`: that `anchor` doesn't resolve to a known `get_reference_doc` page.
- `invalid-event-log`: the file doesn't exist or can't be read (the text
  names the system error, such as `EACCES`, without the path), the file isn't a decodable
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
  `shsBaseUrl` given with no default History Server, `regressionMetric` without `maxRegressionPct`, and a
  `source` whose `shsBaseUrl` or `appId` isn't valid.
