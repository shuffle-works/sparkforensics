import { describe, it, expect } from 'vitest';
import { zstdCompressSync, constants } from 'node:zlib';
import { Decompress } from '../src/vendor/fzstd.js';

// The vendored fzstd's streaming Decompress is locally patched to decode every block into one
// reused [window | block] buffer (see its header). These inputs cross every seam that buffer has:
// many blocks per frame, back-references into earlier blocks and past the window, raw and RLE
// blocks, frames with different windows one after another, and pushes that cut blocks anywhere.
const enc = new TextEncoder();
let seed = 11;
const rand = (k) => { seed = (Math.imul(seed, 1103515245) + 12345) >>> 0; return seed % k; };
const words = Array.from({ length: 400 }, (_, i) => `w${i.toString(36)}${'x'.repeat(i % 9)}`);
const text = (bytes) => {
  let s = '';
  while (s.length < bytes) s += `{"Event":"${words[rand(words.length)]}","v":${rand(1e6)},"s":"${words[rand(words.length)]}"}\n`;
  return enc.encode(s.slice(0, bytes));
};
const noise = (bytes) => Uint8Array.from({ length: bytes }, () => rand(256));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const frame = (content, windowLog) => new Uint8Array(zstdCompressSync(content, windowLog
  ? { params: { [constants.ZSTD_c_windowLog]: windowLog } } : {}));

function decode(bytes, pushSize) {
  const out = [];
  // Copy each chunk: it is a view of the decoder's reused buffer, valid only during ondata.
  const d = new Decompress((chunk) => out.push(chunk.slice()));
  for (let o = 0; o < bytes.length; o += pushSize) d.push(bytes.subarray(o, o + pushSize), o + pushSize >= bytes.length);
  return concat(out);
}

describe('vendored fzstd streaming Decompress', () => {
  it('matches the original bytes across multi-block frames, windows and push sizes', () => {
    const contents = [
      text(900_000), // ~7 blocks, back-references across all of them
      noise(300_000), // incompressible: raw blocks
      new Uint8Array(400_000).fill(7), // RLE blocks
      text(5_000), // one-block frame after big ones
      concat([text(200_000), noise(50_000), text(600_000)]),
    ];
    const frames = [
      frame(contents[0]), frame(contents[1]), frame(contents[2], 10), frame(contents[3]),
      frame(contents[4], 17), // a 128 KB window: references reach past it
    ];
    const stream = concat(frames);
    const expected = concat(contents);
    for (const pushSize of [509, 100_003, 1 << 20, stream.length]) {
      // Buffer.equals: toEqual walks 2.5 MB of typed array element by element.
      expect(Buffer.from(decode(stream, pushSize)).equals(Buffer.from(expected))).toBe(true);
    }
  });
});
