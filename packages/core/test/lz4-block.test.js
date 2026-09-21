import { describe, it, expect } from 'vitest';
import { decodeLz4Block, createLz4BlockDecoder } from '../src/lz4-block.js';

const EXPECTED_TEXT = '{"Event":"Ping"}\n'.repeat(20); // 340 bytes

// A single RAW-method (stored, uncompressed) block wrapping EXPECTED_TEXT.
const RAW_BLOCK_BYTES = new Uint8Array([76,90,52,66,108,111,99,107,16,84,1,0,0,84,1,0,0,0,0,0,0,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10]);

// LZ4-compressed-method block wrapping EXPECTED_TEXT (compresses well: 20 repeats of one 17-byte string).
const LZ4_BLOCK_BYTES = new Uint8Array([76,90,52,66,108,111,99,107,37,29,0,0,0,84,1,0,0,0,0,0,0,255,2,123,34,69,118,101,110,116,34,58,34,80,105,110,103,34,125,10,17,0,255,44,80,110,103,34,125,10]);

describe('decodeLz4Block', () => {
  it('decodes a RAW (stored) block', () => {
    const out = decodeLz4Block(RAW_BLOCK_BYTES);
    expect(new TextDecoder().decode(out)).toBe(EXPECTED_TEXT);
  });

  it('decodes an LZ4-compressed block', () => {
    const out = decodeLz4Block(LZ4_BLOCK_BYTES);
    expect(new TextDecoder().decode(out)).toBe(EXPECTED_TEXT);
  });

  it('decodes multiple concatenated blocks in sequence', () => {
    const combined = new Uint8Array(RAW_BLOCK_BYTES.length + LZ4_BLOCK_BYTES.length);
    combined.set(RAW_BLOCK_BYTES, 0);
    combined.set(LZ4_BLOCK_BYTES, RAW_BLOCK_BYTES.length);
    const out = decodeLz4Block(combined);
    expect(new TextDecoder().decode(out)).toBe(EXPECTED_TEXT + EXPECTED_TEXT);
  });

  it('throws on bad magic bytes', () => {
    const corrupt = RAW_BLOCK_BYTES.slice();
    corrupt[0] = 0; // corrupt the "L" of "LZ4Block"
    expect(() => decodeLz4Block(corrupt)).toThrow(/bad magic/);
  });

  it('throws on an unknown block method', () => {
    const corrupt = RAW_BLOCK_BYTES.slice();
    corrupt[8] = 0x30; // token high nibble 0x30 is neither RAW (0x10) nor LZ4 (0x20)
    expect(() => decodeLz4Block(corrupt)).toThrow(/method/);
  });
});

describe('createLz4BlockDecoder (streaming)', () => {
  const COMBINED = (() => {
    const c = new Uint8Array(RAW_BLOCK_BYTES.length + LZ4_BLOCK_BYTES.length);
    c.set(RAW_BLOCK_BYTES, 0);
    c.set(LZ4_BLOCK_BYTES, RAW_BLOCK_BYTES.length);
    return c;
  })();

  function drain(bytes, sliceSize) {
    const chunks = [];
    const dec = createLz4BlockDecoder((c) => chunks.push(new Uint8Array(c)));
    for (let i = 0; i < bytes.length; i += sliceSize) {
      dec.push(bytes.subarray(i, i + sliceSize));
    }
    dec.end();
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return new TextDecoder().decode(out);
  }

  it('decodes blocks fed in tiny slices that straddle block framing', () => {
    for (const sliceSize of [1, 5, 21, 37, 1000]) {
      expect(drain(COMBINED, sliceSize)).toBe(EXPECTED_TEXT + EXPECTED_TEXT);
    }
  });

  it('end() throws when the stream ends mid-block (trailing undecoded bytes)', () => {
    const dec = createLz4BlockDecoder(() => {});
    dec.push(RAW_BLOCK_BYTES.subarray(0, 30)); // partial block only
    expect(() => dec.end()).toThrow(/[Tt]railing/);
  });

  it('throws on bad magic while streaming', () => {
    const corrupt = RAW_BLOCK_BYTES.slice();
    corrupt[0] = 0;
    const dec = createLz4BlockDecoder(() => {});
    expect(() => dec.push(corrupt)).toThrow(/bad magic/);
  });
});
