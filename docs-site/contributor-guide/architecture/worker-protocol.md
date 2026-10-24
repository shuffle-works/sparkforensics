# Worker protocol

## Message protocol

Worker to main:

- `app`, `stage`, `sql`, `executor`, `job`, `progress`: progressive, posted as
  the parser reads.
- `sqlPlan` (`{ type: 'sqlPlan', data: { executionId, planTree } }`): posted by
  `endSqlExecution` once a SQL execution's plan tree resolves. A repeated
  `SQLExecutionEnd` for that execution posts nothing, so no later `sql` message
  replaces the entry holding its `planTree`.
- `runAggregates`: one whole-run core-time-series summary (busy-core-ms, peak
  concurrency, per-stage task-duration sums), emitted just before `done`.
- `stageExecutorMetrics`: the post-completion re-post described in
  [Streaming](./overview.md#streaming), also emitted just before `done`.
- `stageSpeculationWaste`: the speculation totals of stages that gained
  waste from a TaskEnd after their StageCompleted, also described in
  [Streaming](./overview.md#streaming) and emitted just before `done`.
- `stageLateAttemptWork`: the work of a failed stage attempt's tasks that
  ended after its StageCompleted, also described in
  [Streaming](./overview.md#streaming) and emitted just before `done`.
- `done`, `taskData`, `error`.

`emitParseCompletion` posts the tail in a fixed order: any deferred AQE `sql`
updates, `progress` (`pct: 1`), `stageLateAttemptWork`, `runAggregates`,
`stageSpeculationWaste`, `stageExecutorMetrics`, the terminal `app`, then
`done`.

A parse that rejects in the worker (a dropped file that changed after the drop
makes `slice().arrayBuffer()` throw `NotReadableError`, say) is posted as
`{ type: 'error', message }` by `reportParseFailure`. An async `onmessage`
rejection never reaches the parent's `worker.onerror`, so the worker reports it
itself.

A History Server failure is always the typed payload
`{ type: 'error', source: 'shs', code, message? }`, where `code` is one of
`local-server-unavailable`, `upstream-unreachable`, `application-not-found`,
`access-or-upstream-failure`, or `invalid-event-log`. Fetch and HTTP failures
carry only `code`: never an upstream message, URL, status, or response body.
An `invalid-event-log` from the archive decode can carry a `message` written
by `decodeShsArchive` (`packages/core/src/shs-fetch.ts`): the zip is
unreadable, holds several application attempts or no event log, or an entry
failed to decompress, in which case it names the zip entry and includes the
decoder's error text. The intake shows that message under the recovery text.

Evidence availability has no dedicated worker message: the final `app` message
carries a compact `evidenceInputs` counter summary, and `done.skippedLines`
supplies its parse-integrity input.

Main to worker: `{ type: 'parse', file }`, `{ type: 'parseFiles', files }`
(rolling `eventlog_v2_*` directories, one continuous stream across files),
`{ type: 'parseFromUrl', request }` with `request = { baseUrl, appId, attemptId }`,
and `{ type: 'getTaskData', stageId, reqId }`; `taskData` echoes `stageId` and
`reqId` with `metrics` and `fieldNames`. The SHS request object is normalized
before it reaches the worker:
`{ baseUrl: string, appId: string, attemptId: string | null }`.

Files are read in 512 KiB slices (smaller for small files, so every file gets
at least 100 reads), and `progress { pct, linesProcessed }` posts every 300
lines. `parseFromUrl` reports the download as 0-0.5, then `pct: null` every
2000 lines while parsing.

`taskData` uses structured-clone (`.slice()`) so the worker retains its own
`Float64Array` for re-renders.

Post-parse prefetch: after `done`, main runs `analyzer.ts` to build the
bottleneck catalog, then fires parallel `getTaskData` for every flagged stage
so their widgets render immediately. Unflagged stages are on-demand.

### Decompress worker

A dropped zstd file (`parse`, and each zstd file of a `parseFiles` directory)
is decompressed in a second, nested worker, `packages/core/src/zstd-worker.ts`,
so fzstd and the NDJSON parser run at the same time. The parse worker starts it
on the first zstd file and reuses it for the rest of the parse. It dies with
the parse worker, so the page's `terminate()` also cancels it. Other codecs and
the SHS path (`parseFromUrl`) decompress on the parse worker. A dropped
History Server zip (`parse`) streams its zstd entries through the decompress
worker too.

`packages/core/src/zstd-worker-client.ts` is the parse-worker end: it plugs into
`streamFile` as the `zstdDecoder` option, like the Node CLI's native decoder.
The messages' buffers move by transfer rather than structured-clone copy (a
read slice that is a view of a larger buffer is copied once first, and decoded
output is copied once into a 1 MiB batch):

- Parse to decompress: `start { id }` opens a stream, and replaces any open
  one. `data { id, seq, bytes, final }` carries one compressed read slice.
  `cancel { id }` drops the stream.
- Decompress to parse: `ready` once, at startup. `chunk { id, bytes, length }`
  carries decoded output in batches of up to 1 MiB. `consumed { id, seq }`
  follows the last `chunk` of slice `seq`. `error { id, message }` ends the
  stream, and its message becomes the usual `Could not decompress` error.

Flow control is a window of three input slices: `push()` resolves while fewer
than three slices wait for their `consumed`. Each `chunk` is parsed in its
message handler, so a slice is acknowledged only after its output was parsed,
and at most three slices' output is ever queued. The final `push()` resolves
once every slice is acknowledged. When `streamFile` gives up mid-stream (for
example a failed file read) it calls `cancel()`. A parse exception inside a
`chunk` handler makes the client post `cancel` itself and fail the stream,
which surfaces on the next `push()`.

When the nested worker cannot start (`new Worker` throws or its script fails to
load), the parse worker logs a warning
and decodes with in-thread fzstd, with identical output. A
crash after startup fails the stream it was decoding, and later streams fall
back the same way. The progress
`pct` is the read position, so it can run up to the window ahead of the slice
being parsed. The self-contained `file://` export never parses in the browser
(it opens with its run already analyzed), so it never starts either worker.

### zstd in the browser and in Node

The browser decodes zstd with the vendored fzstd, not `DecompressionStream`. The Node CLI and MCP path (`collectRun`,
`shs-load.ts`) uses `packages/core/src/cli/native-zstd.ts` instead, which walks
frame boundaries itself: Node's own zstd decoders stop after the first frame,
and Spark writes thousands of small ones. A parser change that depends on
chunk shape must hold for both. Native chunks are whole frames, often one full
event line and up to tens of MB (`buildChunkDecoder` decodes those in 512 KiB
slices). For local files, frames of 64 KB or more decompress off the main
thread and arrive as 256 KB pieces, so a native `push()` is async and
`streamFile` awaits it. fzstd's chunks are views of one reused buffer, valid
only until its `ondata` callback returns: copy one before keeping it. On a Node
without native zstd (before 22.15/23.8), and for a frame past 64 MiB, the Node
path falls back to fzstd. The SHS archive loader decodes frames inline, and
only `collectRun` uses the off-thread path.

### Decoder and parser calibration

The decode and parse constants rest on measurements from real logs. "The largest
log" is a 3.5 GB zstd log of 10,217 frames whose frames reach 39 MB.

| Constant or choice | Measurement |
|---|---|
| Native frame walk (`native-zstd.ts`) instead of fzstd | 3-5x faster: the largest log decodes in 1.3-1.8 s against 5.6 s |
| Off-thread decode only for frames of 64 KB or more | Median frame output is 5.8 KB; thresholds of 16-64 KB measure the same and 256 KB loses most of the gain |
| `MAX_FRAMES_IN_FLIGHT` of 4 | The largest log parses in 3.1 s at 711 MB peak RSS; 8 in flight take 3.2 s at 886 MB, 2 take 3.5 s at 607 MB. The pool's output chunk size (64 KB to 1 MB) barely matters |
| `MAX_QUEUED_FRAMES` cap of 64 | Without a cap, small frames queued behind an in-flight one raise peak RSS from 0.6 GB to 4.1 GB |
| `FrameSplitter` resuming its walk across pushes | Re-copying and re-walking a frame on every push costs about 4 GB of copying near the 64 MiB frame limit |
| Off-thread decode overall | Parse time over the 14 calibration logs drops from 9.4 s to 8.1 s. A log with few large frames (12 of 6,455 on a 28 MB log) gains nothing |
| Parsing a second log on a worker thread (`collect-run-pair.ts`) | A worker costs about 50 ms to start and about 100 ms to clone the model of a 140 MB zstd log. A compressed log holds 7 to 12 times its size in event text, so the estimate uses 8 |
| One `TextDecoder.decode` per chunk | About 36k decode calls on the largest log against 227k for a per-line decode, which is about 8x slower |
| Cutting `physicalPlanDescription` before `JSON.parse` | The text is 72% of the AQE-update bytes, which are 73% of the log. On the largest log its values total 1.9 GB of the 3.5 GB stream, and one native frame holds all but 51 MB of a value |
| Reading descriptions of up to 256 Ki chars (`MAX_SCANNED_DESCRIPTION`) | On synthetic input, 33 MB of 20 KB descriptions decode and scan in 36 ms against 7 ms when skipped. 102 MB of 4 MB descriptions take 39 ms against 38 ms, since only the first 256 Ki chars of each value are decoded |
| Deferring AQE updates | 541 of 664 updates on the largest log are superseded, 1.1 MB of plan JSON each once the plan text is cut |
| String scan of `Accumulables` in `parseTaskEnd` | The array is 71% of TaskEnd bytes on the largest log. Parsing its TaskEnd lines takes 0.5 s, against 1.3 s with a whole `JSON.parse`. Validating the scanned IDs would add 0.2 s |
