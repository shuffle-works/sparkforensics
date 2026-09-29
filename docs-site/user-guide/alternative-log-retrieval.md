# Alternative ways to get the logs

Spark writes one event log per application when `spark.eventLog.enabled` is
`true`, into the directory set by `spark.eventLog.dir` (for example
`/tmp/spark-events`, or an HDFS or object-store path). Copy the file for your
application from there. Or download it from a Spark History Server at
`<history-server>/api/v1/applications/<app-id>/logs` and drop the `.zip` it
returns as-is.

`--shs-base-url` is the direct route: point SparkForensics at the History
Server and it fetches the event log itself. The rest of this page covers what
to do when that direct route isn't available, most often a History Server you
can only reach through an SSH bastion.

## When you need this

The most common case is a Spark History Server (SHS) reachable only through
an SSH bastion or jump host (the recipe below is the same regardless of
what's issuing the SSH session), with the event logs themselves living on
Kerberized HDFS and no direct HTTP path from your machine to SHS.

## Why `--shs-base-url` won't work here

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

## The recipe

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

4. Point SparkForensics at the local copy instead of a `shsBaseUrl`:

   - Browser: drop the file onto the landing page, same as any other run
     (see [Getting started](./getting-started.md)).
   - CLI: `npx -p sparkforensics-cli sparkforensics-analyze ./application_XXXX_XXXX` (full flag
     list in [Getting started](./getting-started.md#ci-and-automation)).
   - MCP: call a tool with an absolute path, for example
     `{ "source": { "path": "/home/me/application_XXXX_XXXX" } }` (a relative
     path resolves against the MCP server's working directory, which the
     client chooses; tool reference in [MCP tools reference](./mcp-tools.md)).

The file is the app's native input format either way: a single event-log
file, optionally `.gz`/`.zstd`/`.lz4`/`.snappy`-compressed, or a rolling
`eventlog_v2_*` directory pulled the same way. No conversion step needed:
the codec is detected from the file's contents, not its extension. Spark's
`lzf` codec is not supported.
