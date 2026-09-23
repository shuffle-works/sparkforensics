# Architecture overview

## Core invariant

Task data must never live on the main thread. A Spark job can emit millions of
`SparkListenerTaskEnd` events (240 MB+ of metrics); parsing them on the UI thread
freezes Chrome. The design below enforces that in both deploy modes: the static
zero-backend app, and the optional local-server mode in `server/`, which also
proxies Spark History Server fetches to sidestep CORS.

## Two actors

### Main thread

Owns the DOM (React) and a summary `AppModel` (jobs, stages, sql, executors, no
raw tasks), held in a Zustand store (`src/store/store.ts`).

`src/store/useIngest.ts` is the composition root. It owns the `IngestClient`
lifecycle and wires `model-assembler.ts`'s `createModelCallbacks`
(worker-message → `AppModel`, unchanged from before the view migration) into
store updates: `onProgress` → `parse`; `onDone` → derives
`evidenceAvailability` from the final normalized model plus
`done.skippedLines`, runs `analyzer.ts`, sets `catalog`, and prefetches
flagged-stage task data.

`src/App.tsx` routes on store `status`: idle/error → `DropZone`, parsing → a
live progress readout, ready → `Dashboard`. `src/view/Dashboard.tsx` and
`src/view/detector-registry.tsx` replace `dashboard-renderer.js`'s widget board
(see [Widget rendering](./widget-rendering)).

### Worker (Web Worker, core JS)

Owns the file and `taskStore: Map<stageId, Float64Array>`, keyed by 8-field
stride
`[duration, gcTime, memSpilled, diskSpilled, shuffleRead, shuffleWrite, launchTime, finishTime]`.
Four modules:

- `src/stage-quantiles.ts`, a pure leaf, exporting `finalizeStage`,
  `computeFieldQuantiles`, `computeDurationQuantiles`, `classifySpill`,
  `FIELDS`, and `TASK_FIELD_NAMES` for the task-field packed-array layout.
- `src/event-handlers.ts`, holding `processEvent` and the per-event handler
  functions, `accumulateTask`, `createState`, `dispatchLine`,
  `buildChunkDecoder`, `emitParseCompletion`, `collectStageExecutorMetrics`.
- `src/shs-fetch.ts`, the SHS zip-fetch/decompress path: `runParseFromUrl`,
  `naturalCompare`, `reassembleRollingEntries`, `sniffCodec`.
- `src/parser-worker.ts`, a thin entrypoint (`streamFile`, `runParse`,
  `runParseFiles`, the `isWorker`/`self.onmessage` bus) that barrel-re-exports
  the other three. It is the only piece needing the File/Blob streaming API.

## Streaming

Worker reads the `File` in 4 MB chunks via `file.slice(...).arrayBuffer()`,
`TextDecoder({ stream: true })`, splits on `\n`, JSON-parses, dispatches per event
type. Quantiles (P50/P95/max) and spill classification (`skew | volume |
unclassified`) are computed at `SparkListenerStageCompleted` time, before posting
`StageAggregate` to main.

When `spark.eventLog.logStageExecutorMetrics=true` (default `false`),
`SparkListenerStageExecutorMetrics` events populate
`stage.executorMetrics: Map<execId, {...}>` with the 23 raw peak-memory/GC
fields verbatim (camelCased), consumed by the `memoryUtilization` detector's
per-executor memory bands (see [Memory Utilization](./board-widgets)).

These events can arrive *after* `SparkListenerStageCompleted` for the same
stage, so the per-stage `StageAggregate` message posted at completion time
never carries them. Instead, `collectStageExecutorMetrics(state)` walks every
stage once more just before `done`, and the worker re-posts a single
`stageExecutorMetrics` message (`Map<stageId, Map<execId, metrics>>`, empty
when the log has no such data). Main-thread consumers get every stage's
metrics without a per-stage race.

Compressed logs are inflated inline. `sniffCodec` reads the leading magic bytes:
gzip (`1f 8b`), Zstandard (`28 b5 2f fd`, Spark's `spark.io.compression.codec=zstd`),
Spark's custom `LZ4Block` framing, or Spark's Snappy framing (`org.xerial.snappy`'s
`\x82SNAPPY\0` header, `spark.io.compression.codec=snappy`), falling back to the
filename suffix. Both the dropped-file path and the SHS-fetch path stream
block-by-block (fflate `Gunzip` / fzstd `Decompress` / the LZ4Block decoder /
the Snappy block decoder) to keep one decompressed chunk live at a time.
The Node CLI/MCP paths (`collectRun` for local files, `shs-load.ts` for SHS
archives) swap fzstd for Node's native zlib zstd where the running Node has it
(22.15+/23.8+), through the `zstdDecoder` option of `runParse`/`decodeShsArchive`: `packages/core/src/cli/native-zstd.ts` decompresses one frame at a
time, since Node's own decoders stop after a stream's first frame and Spark
writes thousands of small ones. A frame declaring more than 64 MiB of content,
one still incomplete after 64 MiB compressed, a malformed one, or a truncated
tail goes to fzstd instead. Spark's frames declare no content size, so each
one's output is capped at 64 MiB as it decodes: past that, the inline decoder
hands the frame to fzstd and the threaded one streams it, pausing while 64 MiB
wait to be parsed. On the real logs this made parsing 42% faster. For local files (`nodeParseCodecs`, `createThreadedZstdDecoder`), frames of
64 KB or more compressed decompress on libuv's threadpool, up to 4 at a time,
while the main thread parses earlier output; `streamFile` awaits each `push`, and
chunks still arrive in stream order. That took another 24% off the largest real
log (4.2s to 3.2s) for 139 MB more peak RSS. `decodeShsArchive` decodes each
archive entry in one synchronous call, so SHS archives keep the inline decoder
(`nodeArchiveCodecs`).

The SHS-fetch path does buffer the downloaded zip whole for `unzipSync`. But
one-shotting the decompression of a single entry (fzstd's `decompress()`,
fflate's `gunzipSync()`) would allocate that entry's full declared content size
as one ArrayBuffer, which fails outright for a multi-GB event log. So
`decodeEntry(name, raw, onChunk)` picks the codec's streaming decoder per entry
and invokes `onChunk` per decompressed piece. Decompressors are vendored under
`src/vendor/` (`fflate.js`, `fzstd.js`) plus `src/lz4-block.ts` and
`src/snappy-block.ts`.

Rolling `eventlog_v2_*` directories (Spark's multi-file event-log format,
`events_<index>_<appId>(.codec)` files plus a zero-byte `appstatus_*`
completion marker and, periodically, one `*.compact` merge file) are
reassembled into parse order by `reassembleRollingEntries(names)`: drop the
marker, drop every non-compact `events_*` file at or below the most recent
`.compact` file's index, sort the rest numerically. Both the SHS-zip fetch path
(`runParseFromUrl`) and the local folder-drop path (`runParseFiles`) call this
one function.

`runParseFiles` streams each file in the resulting order through the same
chunked codec dispatch as `runParse`, with a fresh decompressor per file, since
codecs never span a roll boundary. The NDJSON line-decoder is the exception: it
stays alive across all files, because nothing guarantees a roll boundary lands
on a line boundary.
