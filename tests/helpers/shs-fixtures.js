import { zipSync, strToU8, Zip, ZipDeflate } from '@sparkforensics/core/vendor/fflate.js';

export function shsZipFetch(ndjson, { status = 200 } = {}) {
  return async () => {
    if (status !== 200) return new Response(null, { status });
    return new Response(zipSync({ eventlog: strToU8(ndjson) }), { status: 200 });
  };
}

// Builds a zip the way the History Server's download does (Java's
// ZipOutputStream): every entry deflated, including directory entries, with
// sizes left out of the local header and written to a trailing data
// descriptor. Entries keep the key order given. A stored zip would not test
// much: the NDJSON line scanner finds the raw lines inside it anyway.
export function historyServerZip(entries) {
  const chunks = [];
  const zip = new Zip((err, data) => {
    if (err) throw err;
    chunks.push(data);
  });
  for (const [name, bytes] of Object.entries(entries)) {
    const file = new ZipDeflate(name);
    zip.add(file);
    file.push(bytes, true);
  }
  zip.end();
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
