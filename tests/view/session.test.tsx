// @vitest-environment jsdom
//
// After a parse with a real FileSystemFileHandle, `recentFiles.add` registers
// it in IndexedDB; switching away and back restores the catalog from the
// in-session snapshot cache instead of re-parsing.
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import { useIngest } from '../../src/store/useIngest';
import { store, emptyAppModel } from '../../src/store/store';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';

// Methods are non-enumerable so `recentFiles.add`'s IndexedDB `put()`
// structuredClone of the entry doesn't choke on function-valued properties:
// fake-indexeddb runs Node's structuredClone, which can't clone functions.
function fakeHandle(file: File) {
  const handle: { getFile: () => Promise<File> } = Object.create(null);
  Object.defineProperty(handle, 'getFile', { value: async () => file, enumerable: false });
  Object.defineProperty(handle, 'queryPermission', { value: async () => 'granted', enumerable: false });
  Object.defineProperty(handle, 'requestPermission', { value: async () => 'granted', enumerable: false });
  return handle;
}

/** Emits distinct app/stage data keyed off the file name so the test can
 * assert which file's data is currently loaded. */
function makeClient() {
  return {
    startParse: vi.fn((file: File, h: any) => {
      if (file.name === 'a.log') {
        h.onApp({ name: 'app-a', id: 'app-a-id' });
        h.onStage({ id: 1, stageId: 1, name: 'stage-a' });
      } else {
        h.onApp({ name: 'app-b', id: 'app-b-id' });
        h.onStage({ id: 2, stageId: 2, name: 'stage-b' });
      }
      h.onDone();
    }),
    startParseFromUrl: vi.fn(),
    startParseFiles: vi.fn(),
    requestTaskData: async () => ({ metrics: [], fieldNames: [] }),
    prefetchFlaggedStages: async () => [],
    terminate: vi.fn(),
  };
}

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  store.setState({
    ...store.getState(),
    appModel: emptyAppModel(),
    catalog: [],
    activeFileId: null,
    sessionCache: new Map(),
    taskDataCache: new Map(),
    status: 'idle',
    errorMessage: null,
  });
});

test('a successful parse registers the file in recentFiles', async () => {
  const client = makeClient();
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));
  const fileA = new File(['a'], 'a.log');
  const handleA = fakeHandle(fileA);

  act(() => result.current.startLoad(fileA, { handle: handleA }));

  const idA = recentFiles.entryId('a.log', fileA.size, fileA.lastModified);
  // `recentFiles.add` runs at the tail of the async onDone handler, after the
  // synchronous parse callbacks: poll until it lands.
  await waitFor(async () => {
    expect(await recentFiles.list()).toHaveLength(1);
  });
  const entries = await recentFiles.list();
  expect(entries[0].id).toBe(idA);
  expect(entries[0].appName).toBe('app-a');
  expect(store.getState().activeFileId).toBe(idA);
});

test('picking a cached file restores the catalog via applySnapshot without re-parsing', async () => {
  const client = makeClient();
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));

  const fileA = new File(['a'], 'a.log');
  const handleA = fakeHandle(fileA);
  const fileB = new File(['b'], 'b.log');
  const handleB = fakeHandle(fileB);
  const idA = recentFiles.entryId('a.log', fileA.size, fileA.lastModified);
  const idB = recentFiles.entryId('b.log', fileB.size, fileB.lastModified);

  // Load A, then switch to B via pickRecent (an uncached recent entry): this
  // is the only path that snapshots the outgoing file (A) into sessionCache.
  act(() => result.current.startLoad(fileA, { handle: handleA }));
  expect(store.getState().appModel.app?.name).toBe('app-a');
  // Let A's parse fully settle (catalog + recentFiles.add) before switching,
  // so the snapshot captured for A below reflects its finished state.
  await waitFor(() => expect(store.getState().status).toBe('ready'));

  await act(async () => {
    const outcome = await result.current.pickRecent(idB, handleB);
    expect(outcome).toBe('started');
  });
  expect(store.getState().appModel.app?.name).toBe('app-b');
  expect(store.getState().activeFileId).toBe(idB);
  expect(client.startParse).toHaveBeenCalledTimes(2);

  // Switching back to A should now hit the sessionCache: no third parse.
  await act(async () => {
    const outcome = await result.current.pickRecent(idA);
    expect(outcome).toBe('restored');
  });

  expect(client.startParse).toHaveBeenCalledTimes(2); // unchanged: no re-parse
  expect(store.getState().appModel.app?.name).toBe('app-a');
  expect(store.getState().appModel.stages.get(1)?.name).toBe('stage-a');
  expect(store.getState().activeFileId).toBe(idA);
  expect(store.getState().status).toBe('ready');
});
