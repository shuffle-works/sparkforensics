# Alternative ways to get the logs

`--shs-base-url` is the direct route: point SparkForensics at the History
Server and it fetches the event log itself. This page covers what to do when
that direct route isn't available.

## When you need this

The most common case is a Spark History Server (SHS) reachable only through
an SSH bastion or jump host (the recipe below is the same regardless of
what's issuing the SSH session), with the event logs themselves living on
Kerberized HDFS and no direct HTTP path from your machine to SHS.

## Why `--shs-base-url` won't work here

The CLI's `--shs-base-url`/`--app-id` flags and the MCP tools'
`{ shsBaseUrl, appId }` source both make a direct HTTP request from wherever
SparkForensics runs to the History Server's REST API. If that address is
only reachable from inside a bastion, that request never lands: there's no
`--via-ssh` flag or other way to route it through an SSH session.

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
     (see [Getting started](./getting-started)).
   - CLI: `npx sparkforensics-analyze ./application_XXXX_XXXX` (full flag
     list in [Getting started](./getting-started#ci-and-automation)).
   - MCP: call a tool with `{ "source": { "path": "./application_XXXX_XXXX" } }`
     (tool reference in [MCP tools reference](./mcp-tools)).

The file is the app's native input format either way: a single event-log
file, optionally `.gz`/`.zstd`/`.lz4`/`.snappy`-compressed, or a rolling
`eventlog_v2_*` directory pulled the same way. No conversion step needed.
