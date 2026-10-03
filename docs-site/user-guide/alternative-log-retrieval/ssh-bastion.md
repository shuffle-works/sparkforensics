# Behind an SSH bastion

How to fetch a History Server log when the server is only reachable through an SSH bastion.

The most common hard case is a Spark History Server (SHS) reachable only
through an SSH bastion or jump host (the recipe below is the same regardless
of what's issuing the SSH session), with the event logs themselves living on
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

4. Load the local copy as described in [Loading the file](../alternative-log-retrieval.md#loading-the-file).
