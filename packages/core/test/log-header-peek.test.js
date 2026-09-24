import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { peekLogHeader } from '../src/log-header-peek.js';
import { gzipSync, strToU8 } from '../src/vendor/fflate.js';
import { zstdCompressSync } from 'node:zlib';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'dev', 'log-corpus', 'logs', 'external');
const MINIMAL_FIXTURE = join(FIXTURES_DIR, 'external-minimal-eventlog.ndjson');

function fileFromBytes(name, bytes) {
  return {
    name,
    size: bytes.length,
    slice(start, end) {
      const view = bytes.subarray(start, end);
      return { async arrayBuffer() { return view.slice().buffer; } };
    },
  };
}

describe('peekLogHeader', () => {
  // dev/log-corpus is a git submodule (public corpus repo), checked out in CI; skipped locally
  // until `git submodule update --init dev/log-corpus`.
  it.skipIf(!existsSync(MINIMAL_FIXTURE))('extracts appId/name/sparkVersion/startTime from a real uncompressed fixture', async () => {
    const raw = readFileSync(MINIMAL_FIXTURE);
    const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
    const result = await peekLogHeader(fileFromBytes('eventlog', bytes));
    expect(result).not.toBeNull();
    expect(typeof result.appId).toBe('string');
  });

  it('returns null when no SparkListenerApplicationStart appears within the line cap', async () => {
    const lines = Array.from({ length: 60 }, (_, i) => JSON.stringify({ Event: 'SparkListenerJobStart', 'Job ID': i }));
    const bytes = strToU8(`${lines.join('\n')}\n`);
    const result = await peekLogHeader(fileFromBytes('eventlog', bytes));
    expect(result).toBeNull();
  });

  it('returns null for an empty file', async () => {
    const result = await peekLogHeader(fileFromBytes('empty', new Uint8Array(0)));
    expect(result).toBeNull();
  });

  it('reads a bounded prefix, not the whole file, for a huge log with an early header', async () => {
    const header = [
      '{"Event":"SparkListenerLogStart","Spark Version":"3.5.0"}',
      '{"Event":"SparkListenerApplicationStart","App ID":"app-big","App Name":"big","Timestamp":1000}',
    ].join('\n') + '\n';
    const fillerLine = `${'x'.repeat(200)}\n`;
    const filler = fillerLine.repeat(10000); // ~2MB, far past the 50-line cap
    const bytes = strToU8(header + filler);
    let bytesRequested = 0;
    const file = {
      name: 'eventlog',
      size: bytes.length,
      slice(start, end) {
        bytesRequested += end - start;
        const view = bytes.subarray(start, end);
        return { async arrayBuffer() { return view.slice().buffer; } };
      },
    };
    const result = await peekLogHeader(file);
    expect(result).toMatchObject({ appId: 'app-big', name: 'big', sparkVersion: '3.5.0', startTimeMs: 1000 });
    expect(bytesRequested).toBeLessThan(1024 * 1024);
  });

  it('decodes a gzip-compressed header the same way', async () => {
    const ndjson = '{"Event":"SparkListenerLogStart","Spark Version":"3.4.0"}\n'
      + '{"Event":"SparkListenerApplicationStart","App ID":"app-gz","App Name":"g","Timestamp":500}\n';
    const gz = gzipSync(strToU8(ndjson));
    const result = await peekLogHeader(fileFromBytes('eventlog.gz', gz));
    expect(result).toMatchObject({ appId: 'app-gz', sparkVersion: '3.4.0' });
  });

  it('decodes a zstd-compressed header the same way', async () => {
    const ndjson = '{"Event":"SparkListenerLogStart","Spark Version":"3.4.0"}\n'
      + '{"Event":"SparkListenerApplicationStart","App ID":"app-zstd","App Name":"z","Timestamp":500}\n';
    const zst = new Uint8Array(zstdCompressSync(strToU8(ndjson)));
    const result = await peekLogHeader(fileFromBytes('eventlog.zstd', zst));
    expect(result).toMatchObject({ appId: 'app-zstd', sparkVersion: '3.4.0' });
  });

  it("prefers SparkListenerLogStart's Spark Version over ApplicationStart's own", async () => {
    const ndjson = '{"Event":"SparkListenerLogStart","Spark Version":"3.5.0"}\n'
      + '{"Event":"SparkListenerApplicationStart","App ID":"a","App Name":"n","Timestamp":0,"Spark Version":"2.4.0"}\n';
    const result = await peekLogHeader(fileFromBytes('eventlog', strToU8(ndjson)));
    expect(result.sparkVersion).toBe('3.5.0');
  });

  it('still finds the header when the last line has no trailing newline', async () => {
    const ndjson = '{"Event":"SparkListenerLogStart","Spark Version":"3.5.0"}\n'
      + '{"Event":"SparkListenerApplicationStart","App ID":"app-no-nl","App Name":"n","Timestamp":1000}';
    const result = await peekLogHeader(fileFromBytes('eventlog', strToU8(ndjson)));
    expect(result).toMatchObject({ appId: 'app-no-nl', sparkVersion: '3.5.0', startTimeMs: 1000 });
  });
});
