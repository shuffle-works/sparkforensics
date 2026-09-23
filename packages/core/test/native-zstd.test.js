import { describe, it, expect } from 'vitest';
import { zstdCompressSync, createZstdCompress } from 'node:zlib';
import { createNativeZstdDecoder, nativeZstdAvailable } from '../src/cli/native-zstd.ts';

const enc = new TextEncoder();
const text = Array.from({ length: 400 }, (_, i) => `{"Event":"E${i}","v":"${'x'.repeat(i % 37)}€"}\n`).join('');
// Spark-style: many small frames, one per flush.
const frames = [];
for (let o = 0; o < text.length; o += 1000) frames.push(new Uint8Array(zstdCompressSync(enc.encode(text.slice(o, o + 1000)))));
const concat = (parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const multiFrame = concat(frames);
const skippable = (payload) => concat([new Uint8Array([0x50, 0x2a, 0x4d, 0x18, payload.length, 0, 0, 0]), payload]);

function decode(bytes, pushSize, opts) {
  const out = [];
  const dec = createNativeZstdDecoder((c) => out.push(new Uint8Array(c)), opts);
  for (let o = 0; o < bytes.length; o += pushSize) dec.push(bytes.subarray(o, o + pushSize), o + pushSize >= bytes.length);
  return new TextDecoder().decode(concat(out));
}

// Node gained native zstd in 22.15/23.8; collect-run.ts only uses this decoder when it's there.
describe.skipIf(!nativeZstdAvailable)('createNativeZstdDecoder', () => {
  it('decodes every frame of a multi-frame stream for any push size', () => {
    expect(frames.length).toBeGreaterThan(10);
    for (const size of [1, 3, 64, 1000, multiFrame.length]) expect(decode(multiFrame, size)).toBe(text);
  });

  it('skips skippable frames between data frames', () => {
    const mixed = concat([frames[0], skippable(new Uint8Array([1, 2, 3])), ...frames.slice(1)]);
    expect(decode(mixed, 7)).toBe(text);
  });

  // A frame declaring more content than the limit, or still incomplete past it (a single-frame
  // stream with no declared size), goes to fzstd from its first byte: never materialized whole.
  it('streams oversized frames through fzstd, with or without a declared content size', async () => {
    expect(decode(multiFrame, 97, { maxFrameBytes: 500 })).toBe(text);
    const streamed = await new Promise((resolve) => {
      const parts = [];
      const z = createZstdCompress();
      z.on('data', (c) => parts.push(new Uint8Array(c)));
      z.on('end', () => resolve(concat(parts)));
      z.end(enc.encode(text));
    });
    expect(decode(streamed, 5, { maxFrameBytes: 200 })).toBe(text);
  });

  it('fails a truncated last frame with fzstd\'s own error', () => {
    const truncated = multiFrame.subarray(0, multiFrame.length - 5);
    expect(() => decode(truncated, 64)).toThrow('unexpected EOF');
  });

  it('hands bytes that are not a zstd frame to fzstd, which rejects them', () => {
    const corrupt = concat([frames[0], enc.encode('not zstd at all')]);
    expect(() => decode(corrupt, 64)).toThrow();
  });
});
