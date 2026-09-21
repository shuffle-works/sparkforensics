import { zipSync, strToU8 } from '@sparkforensics/core/vendor/fflate.js';

export function shsZipFetch(ndjson, { status = 200 } = {}) {
  return async () => {
    if (status !== 200) return new Response(null, { status });
    return new Response(zipSync({ eventlog: strToU8(ndjson) }), { status: 200 });
  };
}
