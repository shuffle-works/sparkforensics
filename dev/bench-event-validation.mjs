#!/usr/bin/env node
// Manual dev tool: measures the throughput cost per-line
// SparkEventSchema.safeParse adds on top of plain JSON.parse, against the
// largest real fixture available.
//
// Usage: node dev/bench-event-validation.mjs [fixture-dir]
//
// Real Spark event logs are zstd-compressed (the native input format), so the
// largest fixture is decompressed in memory first via the vendored fzstd
// decoder's one-shot decompress(); otherwise JSON.parse would just fail on
// binary data instead of measuring validation cost.
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decompress as zstdDecompress } from '../packages/core/src/vendor/fzstd.js';
import { SparkEventSchema } from '../packages/core/src/event-schemas.ts';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

function isZstd(path, bytes) {
  if (path.endsWith('.zstd') || path.endsWith('.zst')) return true;
  return bytes.length >= 4 && ZSTD_MAGIC.every((b, i) => bytes[i] === b);
}

const fixtureDir = process.argv[2] ?? '../spark-log-examples';
const files = readdirSync(fixtureDir)
  .map((name) => join(fixtureDir, name))
  .filter((p) => statSync(p).isFile());
const largest = files.reduce((a, b) => (statSync(a).size > statSync(b).size ? a : b));

console.log(`Benchmarking against: ${largest} (${(statSync(largest).size / 1e6).toFixed(1)} MB on disk)`);

// Split a Buffer into NDJSON lines without materializing the whole file as one
// JS string: a real log decompresses past V8's ~512MB string ceiling, so decode
// each line via toString(start, end) instead of text.split('\n').
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

const rawBytes = readFileSync(largest);
let buf;
if (isZstd(largest, rawBytes)) {
  const decompressed = zstdDecompress(new Uint8Array(rawBytes));
  buf = Buffer.from(decompressed.buffer, decompressed.byteOffset, decompressed.byteLength);
  console.log(`Decompressed zstd -> ${(decompressed.byteLength / 1e6).toFixed(1)} MB NDJSON`);
} else {
  buf = rawBytes;
}
const lines = splitLines(buf);

function timeIt(label, fn) {
  const start = process.hrtime.bigint();
  let count = 0;
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (fn(parsed)) count++;
    } catch { /* malformed line, same as production dispatchLine */ }
  }
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`${label}: ${ms.toFixed(0)}ms total, ${(ms / lines.length).toFixed(4)}ms/line, ${count} accepted`);
  return ms;
}

const before = timeIt('JSON.parse only (baseline, no schema validation)', () => true);
const after = timeIt('JSON.parse + SparkEventSchema.safeParse', (parsed) => SparkEventSchema.safeParse(parsed).success);

const regressionPct = ((after - before) / before) * 100;
console.log(`\nRegression: ${regressionPct.toFixed(1)}% slower with validation`);
if (regressionPct > 50) {
  console.warn('WARNING: validation adds more than 50% overhead: flag this in the PR description before merging.');
}
