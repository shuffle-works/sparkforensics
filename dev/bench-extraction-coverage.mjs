#!/usr/bin/env node
// Manual dev tool: measures how much of the corpus's raw event-log content
// actually turns into structured data, and names exactly what doesn't.
//
// Usage: node dev/bench-extraction-coverage.mjs [corpus-dir] [--format json] [--strict]
//   corpus-dir  defaults to dev/log-corpus/logs (the spark-event-corpus-data submodule)
//   --format json   print a machine-readable summary instead of the console report
//   --strict        exit 1 if any known-event-type line failed ITS schema (real drift,
//                    never a wallet of "we chose not to model this")
//
// What "counts": every line that decodes as JSON except blank/whitespace-only lines
// and excluded event types (below), none of which carry information regardless of
// tooling and are dropped before classification. Every remaining line lands in exactly
// one bucket, mirroring the real parser's dispatchLine (packages/core/src/event-handlers.ts):
//   extracted   - known Event type, passes its schema: this is what the app reads today.
//   unmodeled   - valid JSON, but `Event` is missing or isn't one of our modeled literals.
//                 Real Spark output we've deliberately not parsed (BlockManagerAdded,
//                 ...). Not a bug; this is the "what are we missing" report.
//   schemaFail  - a KNOWN Event type that doesn't match its own schema. A genuine signal
//                 (schema drift against a real Spark field shape), never silent in the
//                 real parser either (it increments skippedLines there).
//   malformed   - doesn't parse as JSON at all.
// Extraction rate = extracted / (extracted + unmodeled + schemaFail + malformed).
//
// Excluded event types: one per-task line emitted with essentially no payload (Spark
// posts the real metrics on the matching TaskEnd, never on TaskStart), so it dwarfs the
// unmodeled bucket's line count without representing a real extraction gap. Excluded
// entirely (like blank lines) rather than counted as unmodeled.
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { decompress as zstdDecompress } from '../packages/core/src/vendor/fzstd.js';
import { SparkEventSchema } from '../packages/core/src/event-schemas.ts';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const KNOWN_EVENT_TYPES = new Set(SparkEventSchema.options.map((option) => option.shape.Event.value));
const EXCLUDED_EVENT_TYPES = new Set(['SparkListenerTaskStart']);
const SAMPLE_LIMIT = 3; // schema-fail samples kept per (file, eventType) pair

function isZstd(path, bytes) {
  if (path.endsWith('.zstd') || path.endsWith('.zst')) return true;
  return bytes.length >= 4 && ZSTD_MAGIC.every((b, i) => bytes[i] === b);
}

// Splits a Buffer into lines without materializing the whole file as one JS string (a real
// event log can exceed V8's ~512MB string ceiling once decompressed).
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0a) {
      if (i > start) lines.push(buf.toString('utf8', start, i));
      start = i + 1;
    }
  }
  if (start < buf.length) lines.push(buf.toString('utf8', start, buf.length));
  return lines;
}

function readLines(path) {
  const rawBytes = readFileSync(path);
  if (isZstd(path, rawBytes)) {
    const decompressed = zstdDecompress(new Uint8Array(rawBytes));
    return splitLines(Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength));
  }
  return splitLines(rawBytes);
}

function walkLogFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkLogFiles(path));
    } else if (entry.isFile() && ['.ndjson', '.json', '.zst', '.zstd'].includes(extname(entry.name))) {
      out.push(path);
    }
  }
  return out;
}

function newBucket() {
  return { lines: 0, bytes: 0 };
}

function classifyCorpus(corpusDir) {
  const files = walkLogFiles(corpusDir);
  if (files.length === 0) {
    throw new Error(`No log files found under ${corpusDir}`);
  }

  const perFile = [];
  const unmodeledByType = new Map(); // eventType -> {lines, bytes, files: Set}
  const schemaFailByType = new Map(); // eventType -> {lines, bytes, files: Set, samples: [{file, line, issue}]}
  const totals = { extracted: newBucket(), unmodeled: newBucket(), schemaFail: newBucket(), malformed: newBucket(), blank: 0, excluded: 0 };

  for (const path of files) {
    const rel = relative(corpusDir, path);
    const fileTotals = { extracted: newBucket(), unmodeled: newBucket(), schemaFail: newBucket(), malformed: newBucket(), blank: 0, excluded: 0 };

    for (const line of readLines(path)) {
      if (line.trim().length === 0) {
        fileTotals.blank++;
        totals.blank++;
        continue;
      }
      const bytes = Buffer.byteLength(line, 'utf8');

      let parsed;
      try {
        parsed = JSON.parse(line);
      } catch {
        fileTotals.malformed.lines++;
        fileTotals.malformed.bytes += bytes;
        totals.malformed.lines++;
        totals.malformed.bytes += bytes;
        continue;
      }

      const eventType = parsed?.Event;
      if (typeof eventType === 'string' && EXCLUDED_EVENT_TYPES.has(eventType)) {
        fileTotals.excluded++;
        totals.excluded++;
        continue;
      }

      if (typeof eventType !== 'string' || !KNOWN_EVENT_TYPES.has(eventType)) {
        const key = typeof eventType === 'string' ? eventType : '(no Event field)';
        const entry = unmodeledByType.get(key) ?? { lines: 0, bytes: 0, files: new Set() };
        entry.lines++;
        entry.bytes += bytes;
        entry.files.add(rel);
        unmodeledByType.set(key, entry);
        fileTotals.unmodeled.lines++;
        fileTotals.unmodeled.bytes += bytes;
        totals.unmodeled.lines++;
        totals.unmodeled.bytes += bytes;
        continue;
      }

      const result = SparkEventSchema.safeParse(parsed);
      if (!result.success) {
        const entry = schemaFailByType.get(eventType) ?? { lines: 0, bytes: 0, files: new Set(), samples: [] };
        entry.lines++;
        entry.bytes += bytes;
        entry.files.add(rel);
        if (entry.samples.length < SAMPLE_LIMIT) {
          entry.samples.push({ file: rel, line: line.slice(0, 300), issue: result.error.issues[0]?.message ?? 'unknown' });
        }
        schemaFailByType.set(eventType, entry);
        fileTotals.schemaFail.lines++;
        fileTotals.schemaFail.bytes += bytes;
        totals.schemaFail.lines++;
        totals.schemaFail.bytes += bytes;
        continue;
      }

      fileTotals.extracted.lines++;
      fileTotals.extracted.bytes += bytes;
      totals.extracted.lines++;
      totals.extracted.bytes += bytes;
    }

    perFile.push({ path: rel, ...fileTotals });
  }

  return { perFile, unmodeledByType, schemaFailByType, totals };
}

function countedLines(bucket) {
  return bucket.extracted.lines + bucket.unmodeled.lines + bucket.schemaFail.lines + bucket.malformed.lines;
}

function pct(n, d) {
  return d === 0 ? '0.0' : ((n / d) * 100).toFixed(1);
}

function printReport({ perFile, unmodeledByType, schemaFailByType, totals }) {
  const total = countedLines(totals);

  console.log('=== Per-file extraction rate ===');
  for (const f of perFile) {
    const fileTotal = countedLines(f);
    console.log(
      `${pct(f.extracted.lines, fileTotal).padStart(5)}%  extracted  ${f.path}  ` +
        `(${f.extracted.lines}/${fileTotal} lines, ${f.unmodeled.lines} unmodeled, ${f.schemaFail.lines} schema-fail, ${f.malformed.lines} malformed)`
    );
  }

  console.log('\n=== Corpus totals ===');
  console.log(`Files: ${perFile.length}`);
  console.log(`Blank lines (excluded, don't count): ${totals.blank}`);
  console.log(`Excluded event types (don't count, e.g. TaskStart): ${totals.excluded}`);
  console.log(`Counted lines: ${total}  |  bytes: ${(totals.extracted.bytes + totals.unmodeled.bytes + totals.schemaFail.bytes + totals.malformed.bytes).toLocaleString('en-US')}`);
  console.log(
    `Extracted:  ${totals.extracted.lines} lines (${pct(totals.extracted.lines, total)}%), ` +
      `${totals.extracted.bytes.toLocaleString('en-US')} bytes (${pct(totals.extracted.bytes, totals.extracted.bytes + totals.unmodeled.bytes + totals.schemaFail.bytes + totals.malformed.bytes)}%)`
  );
  console.log(`Unmodeled:  ${totals.unmodeled.lines} lines (${pct(totals.unmodeled.lines, total)}%) - known Spark events we don't parse, by design`);
  console.log(`Schema-fail: ${totals.schemaFail.lines} lines (${pct(totals.schemaFail.lines, total)}%) - known Event type, doesn't match its schema (a real bug if nonzero)`);
  console.log(`Malformed:  ${totals.malformed.lines} lines (${pct(totals.malformed.lines, total)}%) - not valid JSON`);

  console.log('\n=== What we are missing: unmodeled Event types, by line count ===');
  const sortedUnmodeled = [...unmodeledByType.entries()].sort((a, b) => b[1].lines - a[1].lines);
  for (const [eventType, entry] of sortedUnmodeled) {
    console.log(`${String(entry.lines).padStart(8)} lines  ${String(entry.files.size).padStart(3)} files  ${eventType}`);
  }

  if (schemaFailByType.size > 0) {
    console.log('\n=== Schema-fail detail (known Event type, real drift) ===');
    for (const [eventType, entry] of schemaFailByType.entries()) {
      console.log(`\n${eventType}: ${entry.lines} lines across ${entry.files.size} file(s)`);
      for (const sample of entry.samples) {
        console.log(`  [${sample.file}] ${sample.issue}`);
        console.log(`    ${sample.line}`);
      }
    }
  }
}

function toJson({ perFile, unmodeledByType, schemaFailByType, totals }) {
  const total = countedLines(totals);
  return {
    files: perFile.map((f) => ({
      path: f.path,
      extractionRatePct: Number(pct(f.extracted.lines, countedLines(f))),
      extracted: f.extracted.lines,
      unmodeled: f.unmodeled.lines,
      schemaFail: f.schemaFail.lines,
      malformed: f.malformed.lines,
      blank: f.blank,
      excluded: f.excluded,
    })),
    totals: {
      blank: totals.blank,
      excluded: totals.excluded,
      countedLines: total,
      extracted: totals.extracted,
      unmodeled: totals.unmodeled,
      schemaFail: totals.schemaFail,
      malformed: totals.malformed,
      extractionRatePct: Number(pct(totals.extracted.lines, total)),
    },
    missingEventTypes: [...unmodeledByType.entries()]
      .sort((a, b) => b[1].lines - a[1].lines)
      .map(([eventType, entry]) => ({ eventType, lines: entry.lines, bytes: entry.bytes, files: entry.files.size })),
    schemaFailures: [...schemaFailByType.entries()].map(([eventType, entry]) => ({
      eventType,
      lines: entry.lines,
      files: [...entry.files],
      samples: entry.samples,
    })),
  };
}

function parseArgs(argv) {
  const args = { corpusDir: null, format: 'text', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--format') {
      const value = argv[++i];
      if (value !== 'json' && value !== 'text') throw new Error(`Unexpected --format value: ${value}`);
      args.format = value;
    } else if (arg === '--strict') args.strict = true;
    else if (!arg.startsWith('--') && !args.corpusDir) args.corpusDir = arg;
    else throw new Error(`Unexpected argument: ${arg}`);
  }
  args.corpusDir ??= 'dev/log-corpus/logs';
  return args;
}

const { corpusDir, format, strict } = parseArgs(process.argv.slice(2));

const result = classifyCorpus(corpusDir);

if (format === 'json') {
  console.log(JSON.stringify(toJson(result), null, 2));
} else {
  printReport(result);
}

if (strict && result.totals.schemaFail.lines > 0) {
  console.error(`\nSTRICT: ${result.totals.schemaFail.lines} line(s) of a known Event type failed schema validation.`);
  process.exit(1);
}
