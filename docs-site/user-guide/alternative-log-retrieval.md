# Finding your event log

SparkForensics reads the Spark event log: the newline-delimited JSON file of
listener events that Spark writes for each application and that the Spark
History Server replays to rebuild the Spark UI. Driver stdout, executor
`stderr` and log4j output are different files and won't load.

Spark writes one event log per application when `spark.eventLog.enabled` is
`true`, into the directory set by `spark.eventLog.dir` (for example
`/tmp/spark-events`, or an HDFS or object-store path). Copy the file for your
application from there. Or download it from a Spark History Server at
`<history-server>/api/v1/applications/<app-id>/logs` and drop the `.zip` it
returns as-is.

Not sure where your cluster writes it? Open the application's Spark UI, go to
the **Environment** tab and look up `spark.eventLog.dir`. The sections below
cover the usual places, platform by platform.

## Spark you run yourself

Event logging is off unless you turn it on, and it has to be on before the
application starts. Pass it at submit time or set it in
`spark-defaults.conf`:

```bash
spark-submit \
  --conf spark.eventLog.enabled=true \
  --conf spark.eventLog.dir=file:///tmp/spark-events \
  my-job.py
```

The directory must exist before the job starts. After the job finishes,
there is one file per application in it, named after the application ID.

With `spark.eventLog.rolling.enabled=true`, Spark writes an `eventlog_v2_*`
directory per application instead, holding numbered `events_*` parts. Load
the whole directory: **Other sources > Choose rolling-log folder** in the
browser, or the directory path in the CLI and MCP tools.

On Kubernetes the driver pod's own filesystem goes away with the pod, so
point `spark.eventLog.dir` at storage that outlives it: a persistent volume
or an object-store path.

See the Spark docs on
[event logging](https://spark.apache.org/docs/latest/monitoring.html#viewing-after-the-fact)
for every setting.

## From a Spark History Server

A History Server reads its logs from `spark.history.fs.logDirectory`. If you
can read that directory, copy the application's file or `eventlog_v2_*`
directory straight out of it.

If you can only reach the History Server over HTTP, download the log instead.
The application list's **Event Log** column has a **Download** link, and
`GET <history-server>/api/v1/applications/<app-id>/logs` returns the same
`.zip`. Drop the `.zip` as-is. For an application that ran more than once,
download one attempt with
`/api/v1/applications/<app-id>/<attempt-id>/logs`.

SparkForensics can also fetch the log for you when your machine reaches the
History Server directly: **Other sources > Fetch from Spark History Server**
in [local-server mode](./getting-started.md#local-server-mode),
`--shs-base-url` and `--app-id` in the
[CLI](./getting-started/ci-and-automation.md#ci-and-automation), or a
`{ shsBaseUrl, appId }` source in the [MCP tools](./mcp-tools.md).

## Loading the file

Once the log is on your machine:

- Browser: drop the file onto the landing page, same as any other run
  (see [Getting started](./getting-started.md)).
- CLI: `npx -p sparkforensics-cli sparkforensics-analyze ./application_XXXX_XXXX` (full flag
  list in [Getting started](./getting-started/ci-and-automation.md#ci-and-automation)).
- MCP: call a tool with an absolute path, for example
  `{ "source": { "path": "/home/me/application_XXXX_XXXX" } }` (a relative
  path resolves against the MCP server's working directory, which the
  client chooses; tool reference in [MCP tools reference](./mcp-tools.md)).

The file is the app's native input format either way: a single event-log
file, optionally `.gz`/`.zstd`/`.lz4`/`.snappy`-compressed, a History Server
`.zip`, or a rolling `eventlog_v2_*` directory. No conversion step needed:
the codec is detected from the file's contents, not its extension. Spark's
`lzf` codec is not supported.

Event logs can hold SQL text, table names, storage paths and host names.
Check a log before you share it outside the environment that produced it.
