import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('node:fs', async (/** @type {() => Promise<typeof import('node:fs')>} */ importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, existsSync: vi.fn(() => true), statSync: vi.fn() };
});

import { statSync } from 'node:fs';
import { pathCacheKey } from '../src/mcp-tools.js';

/** @param {{ mtimeMs: number, ctimeMs: number, size: number }} fields */
function stubFileStat({ mtimeMs, ctimeMs, size }) {
  // @ts-expect-error a partial Stats: pathCacheKey reads only isDirectory, mtimeMs, ctimeMs and size
  vi.mocked(statSync).mockReturnValue({ isDirectory: () => false, mtimeMs, ctimeMs, size });
}

describe('pathCacheKey', () => {
  afterEach(() => vi.clearAllMocks());

  it('produces the same key when mtime, ctime and size all match', () => {
    stubFileStat({ mtimeMs: 111, ctimeMs: 111, size: 4 });
    const a = pathCacheKey('/some/path');
    stubFileStat({ mtimeMs: 111, ctimeMs: 111, size: 4 });
    const b = pathCacheKey('/some/path');
    expect(a).toBe(b);
  });

  it('produces a different key for a same-millisecond replace that changed size', () => {
    // Same-millisecond replace differs only in size: mtimeMs alone would collide and serve a stale cached AppModel.
    stubFileStat({ mtimeMs: 111, ctimeMs: 111, size: 4 });
    const a = pathCacheKey('/some/path');
    stubFileStat({ mtimeMs: 111, ctimeMs: 222, size: 34 });
    const b = pathCacheKey('/some/path');
    expect(a).not.toBe(b);
  });

  it('produces a different key when mtime and size match but ctime differs', () => {
    // rsync --preserve-times / tar can restore identical mtime+size for different content; ctime can't be forged, so it catches what mtime+size miss.
    stubFileStat({ mtimeMs: 111, ctimeMs: 111, size: 4 });
    const a = pathCacheKey('/some/path');
    stubFileStat({ mtimeMs: 111, ctimeMs: 999, size: 4 });
    const b = pathCacheKey('/some/path');
    expect(a).not.toBe(b);
  });
});
