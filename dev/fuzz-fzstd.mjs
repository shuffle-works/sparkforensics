#!/usr/bin/env node
// Checks the vendored, locally patched fzstd (packages/core/src/vendor/fzstd.js) against pristine
// upstream fzstd on real zstd event logs: whole-log output must be byte-identical, and on randomly
// corrupted and truncated prefixes of each log the partial output and the error must match too.
//
// Get upstream with `npm pack fzstd@0.1.1` and extract package/esm/index.mjs (its sha256 is in
// the vendored file's header), then:
//   node dev/fuzz-fzstd.mjs --upstream path/to/index.mjs [--iterations 400] [--seed 12345]
//        [--mutations 4] <log.zstd>...
// Exit code 1 when any case differs. The one known difference: a corrupt window size that
// overflows negative throws "Invalid typed array length" at the same byte in both, with a
// different number in the message.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  const [value] = args.splice(i, 2).slice(1);
  return value;
};
const upstreamPath = opt('--upstream', null);
const iterations = Number(opt('--iterations', 400));
const mutations = Number(opt('--mutations', 4));
let seed = Number(opt('--seed', 12345));
if (!upstreamPath || args.length === 0) {
  console.error('usage: node dev/fuzz-fzstd.mjs --upstream <fzstd esm/index.mjs> [--iterations N] [--seed N] [--mutations N] <log.zstd>...');
  process.exit(2);
}

const upstream = await import(pathToFileURL(resolve(upstreamPath)).href);
const patched = await import(pathToFileURL(join(HERE, '..', 'packages', 'core', 'src', 'vendor', 'fzstd.js')).href);
const rand = (k) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % k; };

// Hash of everything emitted, plus the error message if decoding failed.
function run(fzstd, bytes) {
  const hash = createHash('sha256');
  let emitted = 0;
  try {
    const decoder = new fzstd.Decompress((chunk) => { hash.update(chunk); emitted += chunk.length; });
    for (let o = 0; o < bytes.length; o += 65536) decoder.push(bytes.subarray(o, o + 65536), o + 65536 >= bytes.length);
    return `ok ${emitted} ${hash.digest('hex')}`;
  } catch (err) {
    return `error ${emitted} ${hash.digest('hex')} ${err.message}`;
  }
}

let failures = 0;
for (const path of args) {
  const log = new Uint8Array(readFileSync(path));
  const whole = [run(upstream, log), run(patched, log)];
  if (whole[0] !== whole[1]) failures++;
  console.log(`${path}: whole log ${whole[0] === whole[1] ? 'identical' : `DIFFERS\n  upstream ${whole[0]}\n  patched  ${whole[1]}`}`);
  // Corrupt a prefix of up to 3 MB: enough frames, multi-block ones included, to stay quick.
  const source = log.subarray(0, Math.min(log.length, 3 << 20));
  let same = 0;
  for (let i = 0; i < iterations; i++) {
    const bytes = source.slice(0, Math.min(source.length, 1024 + rand(source.length)));
    for (let m = 1 + rand(mutations); m > 0; m--) bytes[rand(bytes.length)] = rand(256);
    const [a, b] = [run(upstream, bytes), run(patched, bytes)];
    if (a === b) same++;
    else { failures++; console.log(`  case ${i} differs\n    upstream ${a}\n    patched  ${b}`); }
  }
  console.log(`  corrupted: ${same} of ${iterations} identical`);
}
process.exit(failures ? 1 : 0);
