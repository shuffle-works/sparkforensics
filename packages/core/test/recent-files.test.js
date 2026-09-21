// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import {
  add, list, touch, remove, getHandle, entryId, applyUpgrade, DB_VERSION,
} from '../src/recent-files.js';

// Fresh DB per test: replace the global factory so each test is isolated.
beforeEach(() => { globalThis.indexedDB = new IDBFactory(); });

function fakeHandle(tag) { return { __tag: tag }; }

function mkEntry(name, size = 100, lastModified = 1, extra = {}) {
  return { handle: fakeHandle(name), name, size, lastModified, appName: null, issueCount: null, ...extra };
}

describe('recent-files', () => {
  it('adds an entry and lists it back', async () => {
    await add(mkEntry('app-a', 76, 10, { appName: 'App A', issueCount: 4 }));
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0].name).toBe('app-a');
    expect(all[0].appName).toBe('App A');
    expect(all[0].issueCount).toBe(4);
    expect(all[0].handle.__tag).toBe('app-a');
    expect(all[0].id).toBe(entryId('app-a', 76, 10));
  });

  it('dedupes by deterministic id (re-add overwrites)', async () => {
    await add(mkEntry('app-a', 76, 10, { issueCount: 1 }));
    await add(mkEntry('app-a', 76, 10, { issueCount: 9 }));
    const all = await list();
    expect(all).toHaveLength(1);
    expect(all[0].issueCount).toBe(9);
  });

  it('sorts by lastOpenedAt descending and touch re-orders', async () => {
    await add(mkEntry('a'));
    await add(mkEntry('b'));
    let all = await list();
    expect(all[0].name).toBe('b'); // most recently added first
    await touch(entryId('a', 100, 1));
    all = await list();
    expect(all[0].name).toBe('a'); // touched -> now most recent
  });

  it('caps the list at 10, evicting the oldest', async () => {
    for (let i = 0; i < 12; i++) await add(mkEntry(`f${i}`, 100, i));
    const all = await list();
    expect(all).toHaveLength(10);
    const names = all.map(e => e.name);
    expect(names).not.toContain('f0');
    expect(names).not.toContain('f1');
    expect(names).toContain('f11');
  });

  it('removes an entry', async () => {
    await add(mkEntry('a'));
    await remove(entryId('a', 100, 1));
    expect(await list()).toHaveLength(0);
  });

  it('returns the stored handle by id', async () => {
    await add(mkEntry('a'));
    const h = await getHandle(entryId('a', 100, 1));
    expect(h.__tag).toBe('a');
  });

  it('applyUpgrade clears the store (version-bump invalidation)', async () => {
    await add(mkEntry('a'));
    // Reopen at the next version through the module's real upgrade fn, the production upgrade path.
    const all = await new Promise((res, rej) => {
      const r = indexedDB.open('sparkforensics', DB_VERSION + 1);
      r.onupgradeneeded = () => applyUpgrade(r.result);
      r.onsuccess = () => {
        const store = r.result.transaction('recentFiles', 'readonly').objectStore('recentFiles');
        const g = store.getAll();
        g.onsuccess = () => { r.result.close(); res(g.result); };
        g.onerror = () => { r.result.close(); rej(g.error); };
      };
      r.onerror = () => rej(r.error);
    });
    expect(all).toHaveLength(0);
  });
});
