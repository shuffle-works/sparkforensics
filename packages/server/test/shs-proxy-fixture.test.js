import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../index.js';
import { zipSync, strToU8, unzipSync } from '../../core/src/vendor/fflate.js';
import { corpusLog } from '../../core/test/corpus-log.js';

const FIXTURE_DIR = fileURLToPath(new URL('../../../dev/log-corpus/logs', import.meta.url));

function firstBaselineFixture() {
  const name = readdirSync(FIXTURE_DIR)
    .sort()
    .find((entry) => entry.endsWith('-parquet-baseline.ndjson'));
  if (!name) throw new Error(`no *-parquet-baseline.ndjson fixture found in ${FIXTURE_DIR}`);
  return readFileSync(join(FIXTURE_DIR, name), 'utf8');
}

/** @type {import('node:http').Server | undefined} */
let server;
afterEach(() => server && server.close());

/**
 * @param {Parameters<typeof createServer>[0]} opts
 * @returns {Promise<number>}
 */
function listen(opts) {
  const listening = createServer(opts);
  server = listening;
  return new Promise((resolve) => listening.listen(0, '127.0.0.1', () => {
    const address = listening.address();
    resolve(typeof address === 'object' && address ? address.port : 0);
  }));
}

// dev/log-corpus is a git submodule (public corpus repo), checked out in CI; this
// suite skips locally until `git submodule update --init dev/log-corpus`.
describe.skipIf(!corpusLog('.'))('SHS proxy against a static corpus fixture (no Docker, no live Spark)', () => {
  it('streams a real event log through /shs-proxy as a valid ZIP', async () => {
    const ndjson = firstBaselineFixture();
    const fetchImpl = async () => new Response(zipSync({ eventlog: strToU8(ndjson) }), { status: 200 });
    const port = await listen({ staticRoot: process.cwd(), fetchImpl });

    const res = await fetch(
      `http://127.0.0.1:${port}/shs-proxy?baseUrl=http%3A%2F%2Fshs%3A18080&appId=application_1_1`,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/zip');

    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.byteLength).toBeGreaterThan(4);
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    /** @type {Record<string, Uint8Array>} */
    const unzipped = unzipSync(bytes);
    const decoded = new TextDecoder().decode(unzipped.eventlog);
    expect(decoded).toBe(ndjson);
  });
});
