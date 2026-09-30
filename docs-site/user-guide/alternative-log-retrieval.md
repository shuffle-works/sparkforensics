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
[CLI](./getting-started.md#ci-and-automation), or a
`{ shsBaseUrl, appId }` source in the [MCP tools](./mcp-tools.md).

## Amazon EMR

EMR turns event logging on by default. On the cluster, the logs sit on HDFS
under `/var/log/spark/apps/`:

```bash
hdfs dfs -ls /var/log/spark/apps/
hdfs dfs -get /var/log/spark/apps/application_XXXX_XXXX .
```

If your cluster sets `spark.eventLog.dir` to an S3 path, download the file
from there instead (for example with `aws s3 cp`). AWS's
[EMR best-practices guide](https://aws.github.io/aws-emr-best-practices/docs/benchmarks/Analyzing/retrieve_event_logs/)
covers both.

## AWS Glue

Glue writes event logs to S3 when the job has the Spark UI turned on. In the
job parameters:

```text
--enable-spark-ui true
--spark-event-logs-path s3://my-bucket/spark-events/
--enable-spark-ui-legacy-path true
```

Glue has two log formats: Standard, for its own console, and Legacy, which
AWS documents for viewing on a Spark History Server. Ask for Legacy, as the
last parameter above does, or pick it in the console under **Spark UI logging
and monitoring configuration**.

After the run, download the file, or the rolling-log directory when the job
uses `spark.eventLog.rolling.enabled`, from that S3 path. See
[Enabling the Apache Spark web UI for AWS Glue jobs](https://docs.aws.amazon.com/glue/latest/dg/monitor-spark-ui-jobs.html).

## Databricks

Set up compute log delivery on the cluster or job compute before it runs:
**Advanced > Logging**, then pick a Unity Catalog volume, S3 or DBFS path.
Databricks delivers driver, worker and event logs into a subfolder of that
path named after the cluster ID, and keeps delivering until the compute
shuts down. Copy the event log from there. See
[compute log delivery](https://docs.databricks.com/aws/en/compute/configure#compute-log-delivery).

## Dataproc

Google Cloud Dataproc (also called Managed Service for Apache Spark) saves
Spark job history to the cluster's temp bucket, in its
`/spark-job-history` directory, unless the cluster sets
`spark.eventLog.dir` somewhere else. Download the file with
`gcloud storage cp`. See
[Persistent History Server](https://cloud.google.com/dataproc/docs/concepts/jobs/history-server).

## Behind an SSH bastion

The most common hard case is a Spark History Server (SHS) reachable only
through an SSH bastion or jump host (the recipe below is the same regardless
of what's issuing the SSH session), with the event logs themselves living on
Kerberized HDFS and no direct HTTP path from your machine to SHS.

### Why `--shs-base-url` won't work here

The CLI's `--shs-base-url`/`--app-id` flags and the MCP tools'
`{ shsBaseUrl, appId }` source both make a direct HTTP request from wherever
SparkForensics runs to the History Server's REST API. There's no `--via-ssh`
flag. If the bastion can reach the History Server's HTTP port, forward it
(`ssh -L 18080:<shs-host>:18080 <bastion>`) and use
`--shs-base-url http://127.0.0.1:18080`. SparkForensics sends no credentials,
so a History Server that requires Kerberos/SPNEGO sign-in can't be fetched
this way: use the recipe below.

Running in Airflow? The
[sparkforensics-operator](https://github.com/shuffle-works/sparkforensics-operator)
can fetch the log from a History Server behind an SSH tunnel, or run the
analysis on an SSH host that already sees the logs.

### The recipe

1. SSH into the edge node (through the bastion, or whatever gets you there).
2. Pull the event log off HDFS onto local disk on the edge node:

   ```bash
   hdfs dfs -get /path/to/spark-events/application_XXXX_XXXX /tmp/application_XXXX_XXXX
   ```

3. Copy that file back to your own machine through the same bastion, e.g.
   with `scp` or `sftp`:

   ```bash
   scp edge-node:/tmp/application_XXXX_XXXX ./application_XXXX_XXXX
   ```

4. Load the local copy as described in [Loading the file](#loading-the-file).

## Loading the file

Once the log is on your machine:

- Browser: drop the file onto the landing page, same as any other run
  (see [Getting started](./getting-started.md)).
- CLI: `npx -p sparkforensics-cli sparkforensics-analyze ./application_XXXX_XXXX` (full flag
  list in [Getting started](./getting-started.md#ci-and-automation)).
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
