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
Port and environment-variable overrides, and what changes for a static
deploy, are in the [project README](https://github.com/shuffle-works/sparkforensics#deploy-modes).

The [hosted demo](https://shuffle-works.github.io/sparkforensics/) runs the
same dashboard but can't fetch from a History Server. To work on
SparkForensics itself, see [Development setup](../contributor-guide/development-setup.md).

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
