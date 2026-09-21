// Decoder for the framing used by Spark's SnappyCompressionCodec, which wraps
// org.xerial.snappy.SnappyOutputStream: an 8-byte magic + 4-byte big-endian
// version + 4-byte big-endian compatible-version header, followed by a
// sequence of [4-byte big-endian compressed length][raw Snappy block] pairs.
// Each raw block is the standard Snappy format (varint uncompressed length +
// a sequence of literal/copy tagged elements): see
// https://github.com/google/snappy/blob/main/format_description.txt. This is
// a different framing from Spark's own LZ4Block format (src/lz4-block.js).

const MAGIC = [0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00]; // 0x82 'S' 'N' 'A' 'P' 'P' 'Y' 0x00
const HEADER_SIZE = 16; // 8-byte magic + 4-byte version + 4-byte compatible version

function readVarint(bytes: Uint8Array, pos: number): { value: number; next: number } {
  let result = 0, shift = 0, p = pos;
  for (;;) {
    const b = bytes[p++];
    result |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) break;
    shift += 7;
  }
  return { value: result >>> 0, next: p };
}

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function checkMagic(bytes: Uint8Array, pos: number): void {
  for (let i = 0; i < 8; i++) {
    if (bytes[pos + i] !== MAGIC[i]) throw new Error(`Not a Spark SnappyCodec stream: bad magic at offset ${pos}.`);
  }
}

// Decompress one raw Snappy block (varint length + literal/copy elements).
function decompressSnappyBlock(bytes: Uint8Array): Uint8Array {
  const { value: outSize, next: start } = readVarint(bytes, 0);
  const out = new Uint8Array(outSize);
  let ip = start, op = 0;
  const n = bytes.length;
  while (ip < n) {
    const tag = bytes[ip];
    const lowType = tag & 0x3;
    if (lowType === 0) { // literal
      const lenTag = tag >> 2;
      let literalLen, headerLen;
      if (lenTag < 60) {
        literalLen = lenTag + 1;
        headerLen = 1;
      } else {
        const extraBytes = lenTag - 59;
        let lenMinus1 = 0;
        for (let i = 0; i < extraBytes; i++) lenMinus1 |= bytes[ip + 1 + i] << (8 * i);
        literalLen = (lenMinus1 >>> 0) + 1;
        headerLen = 1 + extraBytes;
      }
      out.set(bytes.subarray(ip + headerLen, ip + headerLen + literalLen), op);
      ip += headerLen + literalLen;
      op += literalLen;
    } else if (lowType === 1) { // copy, 1-byte offset: length [4..11], offset [0..2047]
      const length = ((tag >> 2) & 0x7) + 4;
      const offset = ((tag & 0xe0) << 3) | bytes[ip + 1];
      let matchPos = op - offset;
      for (let i = 0; i < length; i++) out[op++] = out[matchPos++];
      ip += 2;
    } else if (lowType === 2) { // copy, 2-byte offset: length [1..64], offset [0..65535]
      const length = (tag >> 2) + 1;
      const offset = bytes[ip + 1] | (bytes[ip + 2] << 8);
      let matchPos = op - offset;
      for (let i = 0; i < length; i++) out[op++] = out[matchPos++];
      ip += 3;
    } else { // copy, 4-byte offset
      const length = (tag >> 2) + 1;
      const offset = (bytes[ip + 1] | (bytes[ip + 2] << 8) | (bytes[ip + 3] << 16) | (bytes[ip + 4] << 24)) >>> 0;
      let matchPos = op - offset;
      for (let i = 0; i < length; i++) out[op++] = out[matchPos++];
      ip += 5;
    }
  }
  return out;
}

export function decodeSnappyBlock(bytes: Uint8Array): Uint8Array {
  checkMagic(bytes, 0);
  const chunks: Uint8Array[] = [];
  let pos = HEADER_SIZE;
  const n = bytes.length;
  while (pos < n) {
    if (n - pos < 4) throw new Error(`Truncated Snappy block length at offset ${pos}.`);
    const blockLen = readUint32BE(bytes, pos);
    const bodyStart = pos + 4;
    if (n - bodyStart < blockLen) throw new Error(`Truncated Snappy block body at offset ${pos}.`);
    const body = bytes.subarray(bodyStart, bodyStart + blockLen);
    chunks.push(decompressSnappyBlock(body));
    pos = bodyStart + blockLen;
  }
  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

// Streaming counterpart: push arbitrary byte slices, each fully-received
// block is decompressed and handed to `onChunk` as it completes. Mirrors
// createLz4BlockDecoder's shape/contract (see src/lz4-block.js).
export function createSnappyBlockDecoder(
  onChunk: (chunk: Uint8Array) => void,
): { push(chunk: Uint8Array): void; end(): void } {
  let buf: Uint8Array = new Uint8Array(0);
  let headerConsumed = false;
  return {
    push(chunk: Uint8Array) {
      if (buf.length === 0) buf = chunk;
      else if (chunk.length) {
        const merged = new Uint8Array(buf.length + chunk.length);
        merged.set(buf); merged.set(chunk, buf.length);
        buf = merged;
      }
      let pos = 0;
      if (!headerConsumed) {
        if (buf.length < HEADER_SIZE) return;
        checkMagic(buf, 0);
        pos = HEADER_SIZE;
        headerConsumed = true;
      }
      while (buf.length - pos >= 4) {
        const blockLen = readUint32BE(buf, pos);
        const bodyStart = pos + 4;
        if (buf.length - bodyStart < blockLen) break; // block not fully arrived yet
        const body = buf.subarray(bodyStart, bodyStart + blockLen);
        onChunk(decompressSnappyBlock(body));
        pos = bodyStart + blockLen;
      }
      buf = pos > 0 ? buf.slice(pos) : buf;
    },
    end() {
      if (buf.length !== 0) throw new Error(`Trailing ${buf.length} undecoded bytes in Snappy stream.`);
    },
  };
}
