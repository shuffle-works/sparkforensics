// @vitest-environment jsdom
import { test, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { store, emptyAppModel } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import type { RunSource } from '@/store/useIngest';
import type { SessionSnapshot } from '@sparkforensics/core/session-snapshot.ts';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';

// A Map that records every set(key, value), so a test can prove a snapshot was
// written exactly once for a key (i.e. never clobbered by a redundant re-write).
class RecordingMap<K, V> extends Map<K, V> {
  sets: Array<[K, V]> = [];
  set(k: K, v: V): this { this.sets.push([k, v]); return super.set(k, v); }
}

// A fake ingest client whose parse methods synchronously drive onApp + onDone,
// so a two-run compare completes without a real worker.
function makeFakeClient(appNameByCall: string[]) {
  let call = 0;
  return {
    startParse: (_file: File, h: any) => {
      const name = appNameByCall[call++];
      h.onApp?.({ id: name, name });
      h.onDone?.({ skippedLines: 0 });
    },
    startParseFiles: (_files: File[], h: any) => { const name = appNameByCall[call++]; h.onApp?.({ id: name, name }); h.onDone?.({ skippedLines: 0 }); },
    startParseFromUrl: (_r: any, h: any) => { const name = appNameByCall[call++]; h.onApp?.({ id: name, name }); h.onDone?.({ skippedLines: 0 }); },
    prefetchFlaggedStages: async () => [],
    requestTaskData: async () => ({ metrics: [], fieldNames: [] }),
    terminate: () => {},
  };
}

const fileSource = (id: string, name: string): RunSource => ({ kind: 'file', id, label: name, file: new File(['{}'], name) });

beforeEach(() => {
  store.getState().resetModel();
  store.setState({ sessionCache: new Map(), activeFileId: null, appModel: emptyAppModel(), compareSeed: null });
});

test('startCompareLoad parses A then B, snapshots both, opens the comparison', async () => {
  const client = makeFakeClient(['SameApp', 'SameApp']);
  // Record every sessionCache.set so we can prove run B's snapshot is written
  // once (by snapshotParsedRun) and never clobbered by openComparison.
  const cache = new RecordingMap<string, SessionSnapshot>();
  store.setState({ sessionCache: cache });
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));
  await act(async () => {
    result.current.startCompareLoad(fileSource('a::1::2', 'a.log'), fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(cache.has('a::1::2')).toBe(true);
  expect(cache.has('b::3::4')).toBe(true);
  expect(store.getState().comparison).toEqual({ active: true, baselineId: 'a::1::2', candidateId: 'b::3::4' });
  expect(store.getState().compareLoad).toBeNull();

  // Regression: snapshotParsedRun must derive the evidence-availability ledger
  // before capturing, so drilling into a compare operand's dashboard doesn't
  // restore a null ledger.
  expect((cache.get('a::1::2') as any)?.evidenceAvailability).not.toBeNull();
  expect((cache.get('b::3::4') as any)?.evidenceAvailability).not.toBeNull();

  // Regression: run B's snapshot is set exactly once (by snapshotParsedRun) and
  // never overwritten by openComparison's auto-snapshot.
  const bSets = cache.sets.filter(([k]) => k === 'b::3::4');
  expect(bSets.length).toBe(1);
  expect(cache.get('b::3::4')).toBe(bSets[0][1]);
  // activeFileId is cleared before openComparison, so its guard skips the
  // harmful re-snapshot of the active run.
  expect(store.getState().activeFileId).toBeNull();
});

test('startCompareLoad exposes compareLoad progress while each run parses', async () => {
  // Regression: {current} must be observable when each run's parse begins, not
  // wiped synchronously by resetModel before any render.
  const observed: Array<{ current: 1 | 2 } | null> = [];
  const client = {
    ...makeFakeClient(['A', 'B']),
    startParse: (_f: File, h: any) => {
      observed.push(store.getState().compareLoad);
      h.onApp?.({ id: 'X', name: 'X' });
      h.onDone?.({ skippedLines: 0 });
    },
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));
  await act(async () => {
    result.current.startCompareLoad(fileSource('a::1::2', 'a.log'), fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(observed).toEqual([{ current: 1 }, { current: 2 }]);
  expect(store.getState().compareLoad).toBeNull();
});

test('a recent-source that is gone surfaces a run-named error prefixed exactly once', async () => {
  // Regression: resolveSourceInput already prefixes "Run B: "; the abort path
  // must not prefix it again.
  const getHandleSpy = vi.spyOn(recentFiles, 'getHandle').mockResolvedValue(null as any);
  const client = makeFakeClient(['A']);
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));
  await act(async () => {
    result.current.startCompareLoad(
      fileSource('a::1::2', 'a.log'),
      { kind: 'recent', id: 'b::3::4', label: 'b.log' },
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  const msg = store.getState().errorMessage ?? '';
  expect(msg).toBe('Run B: this recent file is no longer available.');
  expect(msg.match(/Run B:/g)).toHaveLength(1);
  expect(store.getState().compareLoad).toBeNull();
  expect(store.getState().comparison.active).toBe(false);
  getHandleSpy.mockRestore();
});

test('a parse error on run B aborts the compare and surfaces a run-named error', async () => {
  const client = {
    ...makeFakeClient(['SameApp']),
    startParse: vi.fn()
      .mockImplementationOnce((_f: File, h: any) => { h.onApp?.({ id: 'A', name: 'A' }); h.onDone?.({ skippedLines: 0 }); })
      .mockImplementationOnce((_f: File, h: any) => { h.onError?.({ message: 'bad zstd' }); }),
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));
  await act(async () => {
    result.current.startCompareLoad(fileSource('a::1::2', 'a.log'), fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(store.getState().errorMessage).toMatch(/Run B/);
  expect(store.getState().compareLoad).toBeNull();
  expect(store.getState().comparison.active).toBe(false);
});

test('drillIntoRun restores one cached run without evicting the other', () => {
  store.setState({
    sessionCache: new Map([
      ['a::1::2', { app: { name: 'A' }, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null, catalog: [], taskData: new Map() }],
      ['b::3::4', { app: { name: 'B' }, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null, evidenceAvailability: null, catalog: [], taskData: new Map() }],
    ]),
    comparison: { active: true, baselineId: 'a::1::2', candidateId: 'b::3::4' },
  });
  const { result } = renderHook(() => useIngest());
  act(() => result.current.drillIntoRun('a::1::2'));
  expect(store.getState().activeFileId).toBe('a::1::2');
  expect(store.getState().status).toBe('ready');
  expect(store.getState().comparison.active).toBe(false);
  expect(store.getState().sessionCache.has('b::3::4')).toBe(true); // not evicted
});

test('compareWithAnotherRun keeps the open run as a cached Run A and seeds the landing compare view', async () => {
  const cache = new Map<string, SessionSnapshot>();
  store.setState({
    sessionCache: cache,
    activeFileId: 'a::1::2',
    status: 'ready',
    appModel: { ...emptyAppModel(), app: { id: 'A', name: 'A' } as any },
  });
  const { result } = renderHook(() => useIngest({ makeClient: () => makeFakeClient([]) as any }));
  act(() => result.current.compareWithAnotherRun());

  expect(cache.has('a::1::2')).toBe(true);
  expect(store.getState().compareSeed).toEqual({ id: 'a::1::2', label: expect.any(String) });
  expect(store.getState().status).toBe('idle');
});

test('compareWithAnotherRun stays on the dashboard when the open run has no app to snapshot', () => {
  const cache = new Map<string, SessionSnapshot>();
  store.setState({ sessionCache: cache, activeFileId: 'a::1::2', status: 'ready', compareSeed: null });
  const { result } = renderHook(() => useIngest({ makeClient: () => makeFakeClient([]) as any }));
  act(() => result.current.compareWithAnotherRun());

  expect(cache.has('a::1::2')).toBe(false);
  expect(store.getState().compareSeed).toBeNull();
  expect(store.getState().status).toBe('ready');
  expect(store.getState().activeFileId).toBe('a::1::2');
});

test('startCompareLoad reuses a cached Run A: only Run B is parsed, and A is never re-snapshotted', async () => {
  const startParse = vi.fn();
  const client = makeFakeClient(['B']);
  const cache = new RecordingMap<string, SessionSnapshot>();
  cache.set('a::1::2', { appModel: emptyAppModel() } as unknown as SessionSnapshot);
  cache.sets = [];
  store.setState({ sessionCache: cache });
  const { result } = renderHook(() =>
    useIngest({ makeClient: () => ({ ...client, startParse: (f: File, h: any) => { startParse(); client.startParse(f, h); } }) as any }),
  );
  await act(async () => {
    result.current.startCompareLoad({ kind: 'cached', id: 'a::1::2', label: 'a.log' }, fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });

  expect(startParse).toHaveBeenCalledTimes(1);
  expect(cache.sets.filter(([k]) => k === 'a::1::2')).toHaveLength(0);
  expect(store.getState().comparison).toEqual({ active: true, baselineId: 'a::1::2', candidateId: 'b::3::4' });
});

test('startCompareLoad keeps the compare seed when Run B fails, and clears it once the comparison opens', async () => {
  const seed = { id: 'a::1::2', label: 'a.log' };
  const cache = new Map<string, SessionSnapshot>([['a::1::2', { appModel: emptyAppModel() } as unknown as SessionSnapshot]]);
  const failing = { ...makeFakeClient([]), startParse: (_f: File, h: any) => h.onError?.(new Error('bad log')) };
  store.setState({ sessionCache: cache, compareSeed: seed });
  const failed = renderHook(() => useIngest({ makeClient: () => failing as any }));
  await act(async () => {
    failed.result.current.startCompareLoad({ kind: 'cached', ...seed }, fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(store.getState().compareLoad).toBeNull();
  expect(store.getState().comparison.active).toBe(false);
  expect(store.getState().compareSeed).toEqual(seed);

  const ok = renderHook(() => useIngest({ makeClient: () => makeFakeClient(['B']) as any }));
  await act(async () => {
    ok.result.current.startCompareLoad({ kind: 'cached', ...seed }, fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(store.getState().comparison.active).toBe(true);
  expect(store.getState().compareSeed).toBeNull();
});

test('startCompareLoad reports a cached Run A that is no longer loaded instead of comparing', async () => {
  const { result } = renderHook(() => useIngest({ makeClient: () => makeFakeClient(['B']) as any }));
  await act(async () => {
    result.current.startCompareLoad({ kind: 'cached', id: 'gone::1::2', label: 'a.log' }, fileSource('b::3::4', 'b.log'));
    await Promise.resolve();
  });
  expect(store.getState().errorMessage).toMatch(/^Run A: this run is no longer loaded/);
  expect(store.getState().comparison.active).toBe(false);
});
