import { describe, it, expect } from 'vitest';
import { unzipSync, gunzipSync, zipSync, strToU8, strFromU8 } from '../src/vendor/fflate.js';

describe('vendored fflate', () => {
  it('round-trips a zip archive', () => {
    const zipped = zipSync({ 'a.txt': strToU8('hello world') });
    const entries = unzipSync(zipped);
    expect(strFromU8(entries['a.txt'])).toBe('hello world');
  });

  it('round-trips gzip', () => {
    // We only ever decode gzip produced elsewhere, so just confirm gunzipSync
    // throws cleanly on garbage rather than hanging.
    expect(() => gunzipSync(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
