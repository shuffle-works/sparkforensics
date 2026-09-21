import { describe, it, expect } from 'vitest';
import { decodeSnappyBlock, createSnappyBlockDecoder } from '../src/snappy-block.js';

const MAGIC = [0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]; // 0x82 'S' 'N' 'A' 'P' 'P' 'Y' 0x00

function encodeVarint(n) {
  const bytes = [];
  while (n >= 0x80) { bytes.push((n & 0x7f) | 0x80); n >>>= 7; }
  bytes.push(n);
  return bytes;
}

// Encode payload as a single literal-only raw Snappy block (varint length +
// one literal): format per https://github.com/google/snappy/blob/main/format_description.txt.
function literalBlock(payload) {
  const len = payload.length;
  const lenMinus1 = len - 1;
  let tag;
  if (len <= 60) {
    tag = [((len - 1) << 2) | 0x00];
  } else {
    const extraBytes = lenMinus1 < 0x100 ? 1 : lenMinus1 < 0x10000 ? 2 : lenMinus1 < 0x1000000 ? 3 : 4;
    const lenTag = 59 + extraBytes;
    const lenBytes = [];
    for (let i = 0; i < extraBytes; i++) lenBytes.push((lenMinus1 >>> (8 * i)) & 0xff);
    tag = [(lenTag << 2) | 0x00, ...lenBytes];
  }
  return new Uint8Array([...encodeVarint(len), ...tag, ...payload]);
}

// Raw block encoding "ab" + a 1-byte-offset copy(offset=2, length=8):
// decompresses to "ababababab" (RLE-style backreference, format §2.2.1).
const COPY_BLOCK = new Uint8Array([
  ...encodeVarint(10),
  0x04, 0x61, 0x62, // literal "ab" (tag=(2-1)<<2|0=4)
  0x11, 0x02,       // copy: tag=((offset>>8)<<5)|((8-4)<<2)|1=0x11, offset low byte=2
]);

function xerialHeader() {
  const header = new Uint8Array(16);
  header.set(MAGIC, 0);
  new DataView(header.buffer).setInt32(8, 1, false);  // version (BE)
  new DataView(header.buffer).setInt32(12, 1, false); // compatible version (BE)
  return header;
}

// Frame raw Snappy blocks as a xerial SnappyOutputStream: header + [4-byte-BE length, block] per block.
function frameStream(rawBlocks) {
  const parts = [xerialHeader()];
  for (const block of rawBlocks) {
    const lenPrefix = new Uint8Array(4);
    new DataView(lenPrefix.buffer).setUint32(0, block.length, false);
    parts.push(lenPrefix, block);
  }
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('decodeSnappyBlock', () => {
  it('decodes a single literal-only block', () => {
    const framed = frameStream([literalBlock(new TextEncoder().encode('{"Event":"Ping"}'))]);
    const out = decodeSnappyBlock(framed);
    expect(new TextDecoder().decode(out)).toBe('{"Event":"Ping"}');
  });

  it('decodes a block with a 1-byte-offset copy (backreference)', () => {
    const framed = frameStream([COPY_BLOCK]);
    const out = decodeSnappyBlock(framed);
    expect(new TextDecoder().decode(out)).toBe('ababababab');
  });

  it('decodes multiple concatenated blocks in sequence', () => {
    const framed = frameStream([literalBlock(new TextEncoder().encode('foo')), COPY_BLOCK]);
    const out = decodeSnappyBlock(framed);
    expect(new TextDecoder().decode(out)).toBe('foo' + 'ababababab');
  });

  it('throws on bad magic bytes', () => {
    const framed = frameStream([literalBlock(new TextEncoder().encode('x'))]);
    const corrupt = framed.slice();
    corrupt[0] = 0;
    expect(() => decodeSnappyBlock(corrupt)).toThrow(/bad magic/);
  });
});

describe('createSnappyBlockDecoder (streaming)', () => {
  const COMBINED = frameStream([literalBlock(new TextEncoder().encode('{"Event":"A"}')), COPY_BLOCK]);

  function drain(bytes, sliceSize) {
    const chunks = [];
    const dec = createSnappyBlockDecoder((c) => chunks.push(new Uint8Array(c)));
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

  it('decodes blocks fed in tiny slices that straddle header and block framing', () => {
    for (const sliceSize of [1, 3, 5, 21, 1000]) {
      expect(drain(COMBINED, sliceSize)).toBe('{"Event":"A"}' + 'ababababab');
    }
  });

  it('end() throws when the stream ends mid-block (trailing undecoded bytes)', () => {
    const dec = createSnappyBlockDecoder(() => {});
    dec.push(COMBINED.subarray(0, 20)); // header + length-prefix only, no block body
    expect(() => dec.end()).toThrow(/[Tt]railing/);
  });

  it('throws on bad magic while streaming', () => {
    const corrupt = COMBINED.slice();
    corrupt[0] = 0;
    const dec = createSnappyBlockDecoder(() => {});
    expect(() => dec.push(corrupt)).toThrow(/bad magic/);
  });
});
