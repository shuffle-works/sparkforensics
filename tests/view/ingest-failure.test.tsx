// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { store, emptyAppModel } from '@/store/store';
import { useIngest } from '@/store/useIngest';
import type { RunSource } from '@/store/useIngest';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';

// Lets a test make the analysis step throw, as it would on odd log data.
const analysis = vi.hoisted(() => ({ failWith: null as Error | null }));
vi.mock('@sparkforensics/core/analyzer.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sparkforensics/core/analyzer.ts')>();
  return {
    ...actual,
    analyze: (...args: Parameters<typeof actual.analyze>) => {
      if (analysis.failWith) throw analysis.failWith;
      return actual.analyze(...args);
    },
  };
});

function fakeClient(overrides: Record<string, unknown> = {}) {
  const parse = (_input: unknown, h: any) => {
    h.onApp({ name: 'demo', id: 'app-1' });
    h.onStage({ stageId: 1, name: 's1' });
    h.onDone({ skippedLines: 0 });
  };
  return {
    startParse: parse,
    startParseFiles: parse,
    startParseFromUrl: parse,
    requestTaskData: async () => ({ metrics: [], fieldNames: [] }),
    prefetchFlaggedStages: async () => [],
    terminate: vi.fn(),
    ...overrides,
  };
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

beforeEach(() => {
  analysis.failWith = null;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  store.getState().resetModel();
  store.setState({ sessionCache: new Map(), activeFileId: null, appModel: emptyAppModel(), compareSeed: null });
});

afterEach(() => vi.restoreAllMocks());

test('an analysis failure at parse completion shows the page error instead of staying on Parsing', async () => {
  analysis.failWith = new Error('unexpected log shape');
  const client = fakeClient();
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));

  act(() => result.current.startLoad(new File(['{}'], 'a.log')));
  await settle();

  expect(store.getState().status).toBe('error');
  expect(store.getState().errorMessage).toBe('Could not analyze this log: unexpected log shape');
  expect(client.terminate).toHaveBeenCalled();
});

test('an analysis failure during an SHS fetch also clears the SHS parsing flag', async () => {
  analysis.failWith = new Error('boom');
  const { result } = renderHook(() => useIngest({ makeClient: () => fakeClient() as any }));

  act(() => result.current.startLoadFromUrl({ baseUrl: 'http://shs.example:18080/', appId: 'application_1_1', attemptId: null }, vi.fn()));
  await settle();

  expect(store.getState().status).toBe('error');
  expect(store.getState().shsParsing).toBe(false);
});

test('a failed stage-data prefetch keeps the finished run on screen', async () => {
  const client = fakeClient({ prefetchFlaggedStages: async () => { throw new Error('Worker terminated'); } });
  const { result } = renderHook(() => useIngest({ makeClient: () => client as any }));

  act(() => result.current.startLoad(new File(['{}'], 'a.log')));
  await settle();

  expect(store.getState().status).toBe('ready');
  expect(store.getState().errorMessage).toBeNull();
});

test('a failing recent-files write keeps the finished run on screen', async () => {
  const add = vi.spyOn(recentFiles, 'add').mockRejectedValue(new Error('IndexedDB unavailable'));
  const { result } = renderHook(() => useIngest({ makeClient: () => fakeClient() as any }));

  act(() => result.current.startLoad(new File(['{}'], 'a.log'), { handle: {} }));
  await settle();

  expect(add).toHaveBeenCalled();
  expect(store.getState().status).toBe('ready');
  expect(store.getState().errorMessage).toBeNull();
});

test('pickRecent restoring a cached run resolves when the recent-files touch fails', async () => {
  vi.spyOn(recentFiles, 'touch').mockRejectedValue(new Error('IndexedDB unavailable'));
  const cached = fakeClient();
  const { result } = renderHook(() => useIngest({ makeClient: () => cached as any }));
  act(() => result.current.startLoad(new File(['{}'], 'a.log'), { id: 'a::1::1' }));
  await settle();
  act(() => result.current.resetToDropZone());
  store.getState().setActiveFile(null);

  let outcome: string | undefined;
  await act(async () => { outcome = await result.current.pickRecent('a::1::1'); });

  expect(outcome).toBe('restored');
  expect(store.getState().status).toBe('ready');
});

const fileSource = (id: string, name: string): RunSource => ({ kind: 'file', id, label: name, file: new File(['{}'], name) });

test('a compare load whose source cannot be resolved ends with a run-named error', async () => {
  vi.spyOn(recentFiles, 'getHandle').mockRejectedValue(new Error('IndexedDB unavailable'));
  const { result } = renderHook(() => useIngest({ makeClient: () => fakeClient() as any }));

  await act(async () => {
    result.current.startCompareLoad({ kind: 'recent', id: 'r::1::1', label: 'r' }, fileSource('b::1::1', 'b.log'));
    await Promise.resolve();
  });
  await settle();

  expect(store.getState().compareLoad).toBeNull();
  expect(store.getState().status).toBe('error');
  expect(store.getState().errorMessage).toBe('Baseline: IndexedDB unavailable');
});

test('a compare load whose analysis throws ends with a run-named error', async () => {
  analysis.failWith = new Error('unexpected log shape');
  const { result } = renderHook(() => useIngest({ makeClient: () => fakeClient() as any }));

  await act(async () => {
    result.current.startCompareLoad(fileSource('a::1::1', 'a.log'), fileSource('b::1::1', 'b.log'));
    await Promise.resolve();
  });
  await settle();

  expect(store.getState().compareLoad).toBeNull();
  expect(store.getState().comparison.active).toBe(false);
  expect(store.getState().errorMessage).toBe('Baseline: unexpected log shape');
});
