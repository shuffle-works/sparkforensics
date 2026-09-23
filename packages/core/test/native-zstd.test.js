import { describe, it, expect } from 'vitest';
import { zstdCompressSync, createZstdCompress } from 'node:zlib';
import { createNativeZstdDecoder, createThreadedZstdDecoder, nativeZstdAvailable } from '../src/cli/native-zstd.ts';

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

// Awaits each push, as streamFile does: a no-op for the inline decoder.
async function decode(createDecoder, bytes, pushSize, opts) {
  const out = [];
  const dec = createDecoder((c) => out.push(new Uint8Array(c)), opts);
  for (let o = 0; o < bytes.length; o += pushSize) await dec.push(bytes.subarray(o, o + pushSize), o + pushSize >= bytes.length);
  return new TextDecoder().decode(concat(out));
}

// A zstd frame whose one compressed block is garbage: well-formed to frameEnd, so it reaches
// Node's decoder rather than fzstd.
const garbageFrame = new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x58, 0x45, 0x00, 0x00, ...new Array(8).fill(0xff)]);

// The threaded decoder sends every frame at least `threadedMinFrameBytes` long off the main
// thread: 0 sends all of them, 150 roughly half of this stream's (~100-200 byte) frames.
const DECODERS = [
  ['createNativeZstdDecoder', createNativeZstdDecoder],
  ['createThreadedZstdDecoder, every frame threaded', (onChunk, opts) => createThreadedZstdDecoder(onChunk, { threadedMinFrameBytes: 0, ...opts })],
  ['createThreadedZstdDecoder, mixed', (onChunk, opts) => createThreadedZstdDecoder(onChunk, { threadedMinFrameBytes: 150, ...opts })],
];

// Node gained native zstd in 22.15/23.8; collect-run.ts only uses these decoders when it's there.
describe.skipIf(!nativeZstdAvailable).each(DECODERS)('%s', (_, createDecoder) => {
  it('decodes every frame of a multi-frame stream in order for any push size', async () => {
    expect(frames.length).toBeGreaterThan(10);
    for (const size of [1, 3, 64, 1000, multiFrame.length]) expect(await decode(createDecoder, multiFrame, size)).toBe(text);
  });

  it('skips skippable frames between data frames', async () => {
    const mixed = concat([frames[0], skippable(new Uint8Array([1, 2, 3])), ...frames.slice(1)]);
    expect(await decode(createDecoder, mixed, 7)).toBe(text);
  });

  // A frame declaring more content than the limit, or still incomplete past it (a single-frame
  // stream with no declared size), goes to fzstd from its first byte: never materialized whole.
  it('streams oversized frames through fzstd, with or without a declared content size', async () => {
    expect(await decode(createDecoder, multiFrame, 97, { maxFrameBytes: 500 })).toBe(text);
    const streamed = await new Promise((resolve) => {
      const parts = [];
      const z = createZstdCompress();
      z.on('data', (c) => parts.push(new Uint8Array(c)));
      z.on('end', () => resolve(concat(parts)));
      z.end(enc.encode(text));
    });
    expect(await decode(createDecoder, streamed, 5, { maxFrameBytes: 200 })).toBe(text);
    // Native frames (~1 KB of content each) first, then fzstd takes over at the size-less frame
    // (1.3 KB compressed): its output still comes after theirs.
    expect(await decode(createDecoder, concat([...frames.slice(0, 12), streamed]), 64, { maxFrameBytes: 1200 })).toBe(text.slice(0, 12000) + text);
  });

  it('fails a truncated last frame with fzstd\'s own error', async () => {
    const truncated = multiFrame.subarray(0, multiFrame.length - 5);
    await expect(decode(createDecoder, truncated, 64)).rejects.toThrow('unexpected EOF');
  });

  it('hands bytes that are not a zstd frame to fzstd, which rejects them', async () => {
    const corrupt = concat([frames[0], enc.encode('not zstd at all')]);
    await expect(decode(createDecoder, corrupt, 64)).rejects.toThrow();
  });

  it('fails a well-formed frame whose content is corrupt', async () => {
    await expect(decode(createDecoder, concat([...frames, garbageFrame]), 64)).rejects.toThrow();
  });
});

describe.skipIf(!nativeZstdAvailable)('createThreadedZstdDecoder queue', () => {
  // Small frames behind an off-thread one wait in a capped queue: an uncapped one held most of the
  // largest real log's output. A non-final push of 1 + 204 frames must deliver most of them itself.
  it('delivers small frames queued behind an off-thread frame before the stream ends', async () => {
    let seed = 1;
    const noise = Uint8Array.from({ length: 8192 }, () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24);
    const big = new Uint8Array(zstdCompressSync(noise));
    const smalls = Array.from({ length: 12 }, () => frames).flat();
    const out = [];
    const dec = createThreadedZstdDecoder((c) => out.push(new Uint8Array(c)), { threadedMinFrameBytes: big.length });
    await dec.push(concat([big, ...smalls]), false);
    expect(out.length).toBeGreaterThan(100);
    await dec.push(new Uint8Array(0), true);
    expect(concat(out)).toEqual(concat([noise, ...Array(12).fill(enc.encode(text))]));
  });
});
