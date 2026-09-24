// Random-access zip reader for Spark History Server log archives. Reads the
// central directory from the archive's tail, then inflates one entry at a time
// in bounded slices through fflate's streaming UnzipInflate: the source is read
// a slice at a time and no decompressed entry is ever held whole in memory.
//
// Why the central directory and not fflate's forward-scanning `Unzip`: the
// History Server writes its zip with Java's ZipOutputStream, which leaves
// every local header's sizes blank and puts them in a data descriptor after
// the entry. `Unzip` then has to find each entry's end by scanning the
// compressed bytes for the descriptor signature, and it hands rolling-log
// parts over in archive order, not the order they must be parsed in. The
// central directory has the real sizes and lets the caller pick the order.
import { UnzipInflate, strFromU8 } from './vendor/fflate.js';

export type ZipSource = {
  size: number;
  slice(start: number, end: number): { arrayBuffer(): Promise<ArrayBuffer> };
};

export interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflate; anything else is rejected by streamZipEntry. */
  compression: number;
  compressedSize: number;
  localHeaderOffset: number;
}

const LOCAL_HEADER_SIG = 0x04034b50;
const CENTRAL_HEADER_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_EXTRA_ID = 0x0001;
const EOCD_MIN_SIZE = 22;
// The end-of-central-directory record ends with a comment of at most 65535 bytes.
const EOCD_MAX_SEARCH = EOCD_MIN_SIZE + 0xffff;
const UINT32_MAX = 0xffffffff;

// fflate's UnzipInflate is untyped vendor JS; this local shape types the call site.
type ZipEntryInflater = {
  ondata: (err: Error | null, data: Uint8Array, final: boolean) => void;
  push(chunk: Uint8Array, final?: boolean): void;
};
type ZipEntryInflaterCtor = new () => ZipEntryInflater;

const u16 = (d: Uint8Array, i: number) => d[i] | (d[i + 1] << 8);
const u32 = (d: Uint8Array, i: number) => (d[i] | (d[i + 1] << 8) | (d[i + 2] << 16) | (d[i + 3] << 24)) >>> 0;
const u64 = (d: Uint8Array, i: number) => u32(d, i) + u32(d, i + 4) * 2 ** 32;

async function readRange(source: ZipSource, start: number, end: number): Promise<Uint8Array> {
  if (start < 0 || end > source.size || start > end) throw new Error('zip structure points outside the file');
  return new Uint8Array(await source.slice(start, end).arrayBuffer());
}

/** True when `header` starts with a zip local-file header or an empty archive's EOCD record. */
export function isZip(header: Uint8Array): boolean {
  if (header.length < 4) return false;
  const sig = u32(header, 0);
  return sig === LOCAL_HEADER_SIG || sig === EOCD_SIG;
}

// Locates the central directory via the EOCD record (or its zip64 variant).
async function readDirectoryLocation(source: ZipSource): Promise<{ count: number; offset: number; size: number }> {
  const tailStart = Math.max(0, source.size - EOCD_MAX_SEARCH);
  const tail = await readRange(source, tailStart, source.size);
  let eocd = tail.length - EOCD_MIN_SIZE;
  while (eocd >= 0 && u32(tail, eocd) !== EOCD_SIG) eocd--;
  if (eocd < 0) throw new Error('no end-of-central-directory record');

  const location = { count: u16(tail, eocd + 10), size: u32(tail, eocd + 12), offset: u32(tail, eocd + 16) };
  const locator = tailStart + eocd - 20;
  if (locator >= 0) {
    const loc = await readRange(source, locator, locator + 20);
    if (u32(loc, 0) === ZIP64_EOCD_LOCATOR_SIG) {
      const zip64Offset = u64(loc, 8);
      const z = await readRange(source, zip64Offset, zip64Offset + 56);
      if (u32(z, 0) !== ZIP64_EOCD_SIG) throw new Error('bad zip64 end-of-central-directory record');
      return { count: u64(z, 32), size: u64(z, 40), offset: u64(z, 48) };
    }
  }
  return location;
}

// Reads the zip64 extended-information extra field, which carries (in this
// order) only the sizes/offset whose 32-bit central-directory field is 0xFFFFFFFF.
function applyZip64Extra(dir: Uint8Array, extraStart: number, extraEnd: number, fields: { uncompressed: number; compressed: number; offset: number }): void {
  for (let p = extraStart; p + 4 <= extraEnd;) {
    const id = u16(dir, p), len = u16(dir, p + 2);
    if (id === ZIP64_EXTRA_ID) {
      let q = p + 4;
      for (const key of ['uncompressed', 'compressed', 'offset'] as const) {
        if (fields[key] === UINT32_MAX && q + 8 <= p + 4 + len) { fields[key] = u64(dir, q); q += 8; }
      }
      return;
    }
    p += 4 + len;
  }
}

/** Lists every entry in the archive's central directory, in directory order. */
export async function listZipEntries(source: ZipSource): Promise<ZipEntry[]> {
  const { count, offset, size } = await readDirectoryLocation(source);
  const dir = await readRange(source, offset, offset + size);
  const entries: ZipEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > dir.length || u32(dir, p) !== CENTRAL_HEADER_SIG) throw new Error('bad central-directory header');
    const nameLength = u16(dir, p + 28), extraLength = u16(dir, p + 30), commentLength = u16(dir, p + 32);
    const utf8 = (u16(dir, p + 8) & 0x800) !== 0;
    const nameStart = p + 46, extraStart = nameStart + nameLength;
    const fields = { uncompressed: u32(dir, p + 24), compressed: u32(dir, p + 20), offset: u32(dir, p + 42) };
    applyZip64Extra(dir, extraStart, extraStart + extraLength, fields);
    entries.push({
      name: strFromU8(dir.subarray(nameStart, extraStart), !utf8),
      compression: u16(dir, p + 10),
      compressedSize: fields.compressed,
      localHeaderOffset: fields.offset,
    });
    p = extraStart + extraLength + commentLength;
  }
  return entries;
}

/**
 * Streams one entry's decompressed bytes to `onChunk`, reading `chunkSize`
 * compressed bytes at a time and awaiting `onChunk` before reading more, so an
 * async consumer (an off-thread zstd decoder) applies backpressure. `onRead`
 * reports compressed bytes consumed, for progress.
 */
export async function streamZipEntry(
  source: ZipSource,
  entry: ZipEntry,
  onChunk: (chunk: Uint8Array) => void | Promise<void>,
  { chunkSize, onRead }: { chunkSize: number; onRead?: (bytes: number) => void },
): Promise<void> {
  const header = await readRange(source, entry.localHeaderOffset, entry.localHeaderOffset + 30);
  if (u32(header, 0) !== LOCAL_HEADER_SIG) throw new Error(`bad local header for "${entry.name}"`);
  const dataStart = entry.localHeaderOffset + 30 + u16(header, 26) + u16(header, 28);
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > source.size) throw new Error(`"${entry.name}" is truncated`);
  if (entry.compression !== 0 && entry.compression !== 8) {
    throw new Error(`"${entry.name}" uses unsupported zip compression method ${entry.compression}`);
  }

  const pending: Uint8Array[] = [];
  let inflateError: Error | null = null;
  const inflater = entry.compression === 8 ? new (UnzipInflate as unknown as ZipEntryInflaterCtor)() : null;
  if (inflater) {
    inflater.ondata = (err, data) => {
      if (err) inflateError = err;
      else if (data.length) pending.push(data);
    };
  }

  for (let offset = dataStart; offset < dataEnd;) {
    const end = Math.min(dataEnd, offset + chunkSize);
    const slice = await readRange(source, offset, end);
    offset = end;
    if (inflater) inflater.push(slice, offset >= dataEnd);
    else pending.push(slice);
    if (inflateError) throw inflateError;
    onRead?.(slice.length);
    // Inflate output chunks are views that fflate may reuse on the next push,
    // so each is fully consumed here before the loop reads further.
    while (pending.length) await onChunk(pending.shift()!);
  }
}
