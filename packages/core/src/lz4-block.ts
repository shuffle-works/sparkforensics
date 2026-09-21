const MAGIC = [76, 90, 52, 66, 108, 111, 99, 107]; // "LZ4Block"

function readInt32LE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0;
}

// Standard LZ4 block decompression (the same algorithm used by every LZ4
// implementation: only the outer per-block framing above is Spark-specific).
function decompressLz4Sequence(input: Uint8Array, outSize: number): Uint8Array {
  const out = new Uint8Array(outSize);
  let ip = 0, op = 0;
  const n = input.length;
  while (ip < n) {
    const token = input[ip++];
    let literalLength = token >> 4;
    if (literalLength === 15) {
      let b;
      do { b = input[ip++]; literalLength += b; } while (b === 255);
    }
    out.set(input.subarray(ip, ip + literalLength), op);
    ip += literalLength;
    op += literalLength;
    if (ip >= n) break; // final sequence has no match part
    const offset = input[ip] | (input[ip + 1] << 8);
    ip += 2;
    let matchLength = token & 0x0f;
    if (matchLength === 15) {
      let b;
      do { b = input[ip++]; matchLength += b; } while (b === 255);
    }
    matchLength += 4; // minimum match length
    let matchPos = op - offset;
    for (let i = 0; i < matchLength; i++) out[op++] = out[matchPos++];
  }
  return out;
}

// Streaming counterpart to decodeLz4Block: push byte slices, each complete LZ4Block block is
// decompressed and handed to `onChunk` as it completes, so output is never fully buffered. Partial
// trailing bytes are retained until the next push. `onChunk` must consume synchronously (it aliases
// the internal buffer for RAW blocks, not retained across the next push).
export function createLz4BlockDecoder(
  onChunk: (chunk: Uint8Array) => void,
): { push(chunk: Uint8Array): void; end(): void } {
  let buf: Uint8Array = new Uint8Array(0);
  return {
    push(chunk: Uint8Array) {
      if (buf.length === 0) {
        buf = chunk;
      } else if (chunk.length) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf); merged.set(chunk, buf.length);
        buf = merged;
      }
      let pos = 0;
      while (buf.length - pos >= 21) {
        for (let i = 0; i < 8; i++) {
          if (buf[pos + i] !== MAGIC[i]) {
            throw new Error(`Not a Spark LZ4Block stream: bad magic at offset ${pos}.`);
          }
        }
        const method = buf[pos + 8] & 0xf0;
        const compressedLength = readInt32LE(buf, pos + 9);
        const decompressedLength = readInt32LE(buf, pos + 13);
        const bodyStart = pos + 21;
        if (buf.length - bodyStart < compressedLength) break; // block not fully arrived yet
        const body = buf.subarray(bodyStart, bodyStart + compressedLength);

        let out;
        if (method === 0x10) {
          out = body;
        } else if (method === 0x20) {
          out = decompressLz4Sequence(body, decompressedLength);
        } else {
          throw new Error(`Unknown LZ4Block method 0x${method.toString(16)} at offset ${pos}.`);
        }
        if (out.length !== decompressedLength) {
          throw new Error(`LZ4Block length mismatch at offset ${pos}: expected ${decompressedLength}, got ${out.length}.`);
        }
        onChunk(out);
        pos = bodyStart + compressedLength;
      }
      // Copy (not subarray) the unconsumed tail so the large read-slice buffer
      // can be garbage-collected instead of being pinned by a view.
      buf = pos > 0 ? buf.slice(pos) : buf;
    },
    end() {
      if (buf.length !== 0) {
        throw new Error(`Trailing ${buf.length} undecoded bytes in LZ4Block stream.`);
      }
    },
  };
}

export function decodeLz4Block(bytes: Uint8Array): Uint8Array {
  const chunks: Uint8Array[] = [];
  let pos = 0;
  const n = bytes.length;
  while (pos < n) {
    for (let i = 0; i < 8; i++) {
      if (bytes[pos + i] !== MAGIC[i]) {
        throw new Error(`Not a Spark LZ4Block stream: bad magic at offset ${pos}.`);
      }
    }
    const token = bytes[pos + 8];
    const method = token & 0xf0;
    const compressedLength = readInt32LE(bytes, pos + 9);
    const decompressedLength = readInt32LE(bytes, pos + 13);
    // checksum at pos+17..pos+20 (xxhash32 of decompressed data), not verified
    const bodyStart = pos + 21;
    const body = bytes.subarray(bodyStart, bodyStart + compressedLength);

    let chunk;
    if (method === 0x10) {
      chunk = body;
    } else if (method === 0x20) {
      chunk = decompressLz4Sequence(body, decompressedLength);
    } else {
      throw new Error(`Unknown LZ4Block method 0x${method.toString(16)} at offset ${pos}.`);
    }
    if (chunk.length !== decompressedLength) {
      throw new Error(`LZ4Block length mismatch at offset ${pos}: expected ${decompressedLength}, got ${chunk.length}.`);
    }
    chunks.push(chunk);
    pos = bodyStart + compressedLength;
  }

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
