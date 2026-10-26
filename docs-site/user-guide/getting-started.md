# Getting started

SparkForensics reads a Spark History Server event log and turns it into a
dashboard of flagged bottlenecks. No account needed.

## Run it locally {#local-server-mode}

The recommended way to run SparkForensics on your machine:

```sh
npx sparkforensics-server
```

Open `http://127.0.0.1:4173` and drop a log in. This is **local-server
mode**: it also fetches runs from a Spark History Server on your behalf.
Port and environment-variable overrides are in
[Server configuration](#server-configuration). What changes for a static
deploy is in the [project README](https://github.com/shuffle-works/sparkforensics#deploy-modes).

The [hosted demo](https://shuffle-works.github.io/sparkforensics/) runs the
same dashboard but can't fetch from a History Server. To work on
SparkForensics itself, see [Development setup](../contributor-guide/development-setup.md).

### Server configuration {#server-configuration}

All settings have working defaults. Override them with environment variables:

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `4173` | Listen port, a whole number from 0 to 65535. The `--port` flag takes precedence. Another value, or an unknown flag, exits `2`; a port already in use exits `1`. |
| `SPARKFORENSICS_SHS_BASE_URL` | none | Default History Server URL. The CLI uses it for `--app-id` and `--baseline-app-id` when `--shs-base-url` or `--baseline-shs-base-url` is not given. `sparkforensics-mcp` uses it for a `source` or `list_runs` call without `shsBaseUrl`. A flag takes precedence. |
| `SPARKFORENSICS_SHS_TIMEOUT_MS` | `30000` | History Server fetch timeout. Response headers must arrive within this window, and a streaming body that goes idle this long is cut off. It applies to the `/shs-proxy` route and the MCP archive download. Progressing downloads of any size are unaffected. |
| `SPARKFORENSICS_MCP_CACHE_CAP` | `8` | Most parsed runs kept in the MCP tool cache. |
| `SPARKFORENSICS_MCP_CACHE_TTL_MS` | `900000` | Idle eviction time for cached MCP runs (15 minutes). |
| `SPARKFORENSICS_MAX_ARCHIVE_BYTES` | `1073741824` | Largest History Server event-log archive the MCP tools or the CLI's `--shs-base-url` mode buffer (1 GiB). A larger response fails with `archive-too-large`. |

## Load a run

Drop a log file onto the landing page, or click **Choose file** to pick one.
Parsing runs in a background worker, off the browser's main thread, so a
multi-hundred-megabyte event stream doesn't freeze the tab. While it runs,
the progress screen shows how far along it is and roughly how long is left;
**Cancel** returns to the landing page.

No log of your own yet? Click **Try a sample run** on the landing page to
load a bundled example run and see a populated dashboard right away. A line
above its verdict says it is the sample, with **Load my event log** and a
link to where to find one, so you can switch to your own run from there. **Where
do I find my event log?**, under the buttons, is a short guide to turning
event logging on and downloading a log from a History Server.

The app takes a newline-delimited JSON event log (one JSON event per line,
the format Spark writes to `spark.eventLog.dir`), either plain or
gzip/Zstandard/LZ4/Snappy-compressed. It also takes the zip a Spark History
Server hands back, from the Spark UI's download link or from `GET
/api/v1/applications/<appId>/logs`, as-is: drop the `.zip` and the app
unwraps the log inside it, or reassembles the parts of a rolling log. The zip
must hold one attempt: for an application that ran more than once, download
`/api/v1/applications/<appId>/<attemptId>/logs` instead. Spark's `lzf` codec
is not supported: set `spark.eventLog.compression.codec` to `zstd`, `lz4` or
`snappy`.

Click **Other sources** on the landing page for two more ways in:

- **Choose rolling-log folder**, for an `eventlog_v2_*` rolling directory.
  Drop the folder or point the picker at it; the app reassembles its parts
  in order before parsing.
- **Fetch from Spark History Server**, to pull an application straight from
  a reachable History Server. This needs **local-server mode** (see [Run it locally](#local-server-mode))
  and an application ID in one of the forms Spark itself uses:
  `application_<timestamp>_<id>`, `local-<timestamp>`, `app-<id>`,
  `spark-<id>`, or `driver-<id>`. If the fetch fails, the panel names the
  problem (server unreachable, application not found, local server not
  running, and so on) and suggests what to try next.

Can't reach the History Server directly (it's only reachable through an SSH
bastion)? See [Behind an SSH bastion](./alternative-log-retrieval/ssh-bastion.md#behind-an-ssh-bastion).

In Chromium-based browsers, single files you open stay listed under
**Recent files** on the landing page. Rolling-log folders, History Server
fetches and the sample run are not listed.

## Other ways in {#other-ways-in}

The dashboard is one of several ways to use SparkForensics:

- **Command line and CI.** The `sparkforensics-analyze` CLI reads the same
  event logs, prints a JSON or Markdown report, and exits non-zero when a run
  breaks a budget you set. See [CI and automation](./getting-started/ci-and-automation.md).
- **AI assistants.** The MCP server (`npx sparkforensics-mcp`) lets an agent
  diagnose, summarize and compare runs. See [MCP tools reference](./mcp-tools.md).
- **Airflow.** [sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator)
  runs the analysis after every Spark job and acts on the result.

## Glossary {#glossary}

Terms used across the user guide:

| Term | Meaning |
|------|---------|
| AQE | Adaptive Query Execution. Spark re-plans a query at run time, for example to split a skewed join or coalesce small shuffle partitions. |
| P95 | The 95th percentile: 95% of the values are at or below it. For task times, it is the duration that only the slowest 5% of tasks exceed. |
| SHS | Spark History Server, the service that serves the event logs of finished applications. |
| Core-hours | The sum, over executors, of cores times the hours each executor was alive. It measures the compute a run reserved, not the compute it used. See [Allocation](./getting-started/ci-and-automation.md#allocation). |
| GB-h | Gigabyte-hours: executor memory times the hours the executor was alive. The report calls it `memoryGbHours`. |
| Core-milliseconds | The unit of executor core time. One core busy for one millisecond is one core-millisecond. |
| Stage fingerprint | The key that identifies a stage: its normalized name plus its plan nodes. The same stage has the same fingerprint in two runs, so a comparison can pair them. |
| NDJSON | Newline-delimited JSON: one JSON value per line. Spark writes event logs in this format, and the CLI uses it to report several candidates. |
| Sequence alignment | The method a comparison uses to pair SQL executions and stages across two runs. It keeps the submission order and picks the best-scoring pairs. See [How stages are matched](./run-comparison/how-stages-are-matched.md). |
| Confidence | How sure a detector is that a finding is real. It scales with how far the measured value is past the threshold and with the sample size. [Advanced view](./getting-started/reading-the-dashboard.md#advanced-view) shows it when it is below high. |
