// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIngest } from '../../src/store/useIngest';
import { store, emptyAppModel, selectAppModel, selectCatalog, selectConfigFindings } from '../../src/store/store';
import { interpretationOf } from '../../src/view/interpretation';
import { deserializeRun, serializeRun } from '@sparkforensics/core/run-serialization.ts';
import * as recentFiles from '@sparkforensics/core/recent-files.ts';
import { makeRun, runState } from './_shared/run';

function fakeClient(doneArg?: any) {
  let handlers: any;
  return {
    startParse: (_f: File, h: any) => {
      handlers = h;
      h.onApp({ name: 'demo', id: 'app-1' });
      h.onStage({ stageId: 1, name: 's1' });
      h.onDone(doneArg);
    },
    startParseFromUrl: vi.fn(),
    startParseFiles: vi.fn(),
    requestTaskData: async (_id: number) => ({ metrics: [1], fieldNames: ['duration'] }),
    prefetchFlaggedStages: async () => [],
    terminate: vi.fn(),
    __handlers: () => handlers,
  };
}

test('startLoadFromUrl recovers typed SHS errors through its callback without setting a page error', () => {
  const client = fakeClient();
  const onShsError = vi.fn();
  store.setState({ ...store.getState(), run: null, runKey: null, status: 'idle', errorMessage: null });
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoadFromUrl({
    baseUrl: 'http://shs.example:18080/',
    appId: 'application_1_1',
    attemptId: null,
  }, onShsError));
  act(() => client.startParseFromUrl.mock.calls[0][1].onError({ source: 'shs', code: 'application-not-found' }));

  expect(onShsError).toHaveBeenCalledWith({ source: 'shs', code: 'application-not-found' });
  expect(store.getState().status).toBe('idle');
  expect(store.getState().errorMessage).toBeNull();
  expect(store.getState().shsParsing).toBe(false);
});

test('startLoadFromUrl flags an SHS parse; a following local load clears the flag', () => {
  const client = fakeClient();
  store.setState({ ...store.getState(), run: null, runKey: null, status: 'idle', shsParsing: false });
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoadFromUrl(
    { baseUrl: 'http://shs.example:18080/', appId: 'application_1_1', attemptId: null },
    vi.fn(),
  ));
  expect(store.getState().shsParsing).toBe(true);

  // A local load routes through begin() (resetModel), which clears the flag:
  // no per-entry-point wrapper needed in DropZone.
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(store.getState().shsParsing).toBe(false);
});

test('startLoadFromUrl keeps non-SHS errors on the existing page-level route', () => {
  const client = fakeClient();
  const onShsError = vi.fn();
  store.setState({ ...store.getState(), run: null, runKey: null, status: 'idle', errorMessage: null });
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoadFromUrl({
    baseUrl: 'http://shs.example:18080/',
    appId: 'application_1_1',
    attemptId: null,
  }, onShsError));
  act(() => client.startParseFromUrl.mock.calls[0][1].onError({ message: 'Worker crashed' }));

  expect(onShsError).not.toHaveBeenCalled();
  expect(store.getState().status).toBe('error');
  expect(store.getState().errorMessage).toBe('Worker crashed');
  expect(store.getState().shsParsing).toBe(false);
});

test('startLoad streams into the store and sets catalog on done', () => {
  store.setState({ ...store.getState(), run: null, runKey: null });
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(selectAppModel(store.getState()).app?.name).toBe('demo');
  expect(selectAppModel(store.getState()).stages.size).toBe(1);
  expect(store.getState().status).toBe('ready');
});

test('startLoad stores the skipped-line count from the done payload', () => {
  store.setState({ ...store.getState(), run: null, runKey: null });
  const { result } = renderHook(() =>
    useIngest({ makeClient: () => fakeClient({ skippedLines: 5 }) }),
  );
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(selectAppModel(store.getState()).skippedLines).toBe(5);
});

test('startLoad resets skippedLines to 0 when the done payload omits it', () => {
  store.setState({ ...store.getState(), ...runState({ appModel: { ...emptyAppModel(), skippedLines: 7 } }) });
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(selectAppModel(store.getState()).skippedLines).toBe(0);
});

test('runDone derives availability before analysis and snapshots it', () => {
  store.setState({ ...store.getState(), run: null, runKey: null });
  const client = fakeClient({ skippedLines: 0 });
  client.startParse = (_f: File, h: any) => {
    h.onApp({
      name: 'demo', id: 'app-1',
      evidenceInputs: {
        environmentUpdates: 1, applicationEnds: 1, stageSubmissions: 1, rddStorageSnapshots: 0,
        sqlExecutions: 0, resolvedSqlPlans: 0, executorMetricRows: 0, taskRecords: 2,
      },
    });
    h.onRunAggregates({});
    h.onDone({ skippedLines: 0 });
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoad(new File(['{}'], 'evidence.log')));

  expect(selectAppModel(store.getState()).evidenceAvailability?.schemaVersion).toBe(1);
  expect(selectAppModel(store.getState()).evidenceAvailability?.entries.find((entry) => entry.key === 'taskCoreTime')).toMatchObject({
    state: 'notEmitted', reasonCode: 'noUsableCoreTimeAggregate',
  });
  // 'evidenceAvailability' is a legacy finding type no current detector emits; this
  // guards against a regression that would resurrect it, so the type field is checked as a string.
  expect(selectCatalog(store.getState()).every((finding) => (finding.type as string) !== 'evidenceAvailability')).toBe(true);
  const restored = deserializeRun(serializeRun(store.getState().run!)).appModel;
  expect(restored.evidenceAvailability).toEqual(selectAppModel(store.getState()).evidenceAvailability);
});

test('runDone derives configFindings from the app config, once, alongside catalog', () => {
  store.setState({ ...store.getState(), run: null, runKey: null });
  const client = fakeClient();
  client.startParse = (_f: File, h: any) => {
    h.onApp({
      name: 'demo', id: 'app-1',
      resources: { dynamicAllocationEnabled: true },
    });
    h.onDone({});
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoad(new File(['x'], 'log')));

  expect(selectConfigFindings(store.getState())).toContainEqual(
    expect.objectContaining({ type: 'configAudit', property: 'spark.dynamicAllocation.maxExecutors' }),
  );
});

// Counts the runs installed while `run` executes, as distinct run objects: the interpretation is
// part of the run, so one install is one interpretation of the finished log.
async function runsInstalled(run: () => void | Promise<void>): Promise<number> {
  const seen = new Set<unknown>();
  const unsubscribe = store.subscribe((next, previous) => {
    if (next.run !== previous.run) seen.add(next.run);
  });
  try {
    await run();
  } finally {
    unsubscribe();
  }
  return seen.size;
}

test('runDone installs the finished run once, not once per store update', async () => {
  store.setState({ ...store.getState(), run: null, runKey: null });
  const client = fakeClient();
  let handlers: any;
  client.startParse = (_f: File, h: any) => {
    handlers = h;
    h.onApp({ name: 'demo', id: 'app-1' });
    h.onStage({ stageId: 1, name: 's1' });
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  // The parse builds its own model: the store holds no run until the log is analyzed.
  expect(store.getState().run).toBeNull();

  const changes = await runsInstalled(() => act(() => handlers.onDone({ skippedLines: 0 })));

  const state = store.getState();
  expect(changes).toBe(1);
  expect(interpretationOf(state.run!).findings).toEqual([...selectCatalog(state), ...selectConfigFindings(state)]);
});

test('switching to a cached run installs it once', async () => {
  const snapshot = serializeRun(makeRun({ appModel: { ...emptyAppModel(), app: { name: 'cached', id: 'app-2' } as any }, taskData: { kind: 'none' } }));
  store.setState({
    ...store.getState(), run: null, runKey: null, activeFileId: 'a::1::2',
    sessionCache: new Map([['b::3::4', snapshot]]),
  });
  vi.spyOn(recentFiles, 'touch').mockResolvedValue(undefined);
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));

  const changes = await runsInstalled(() => act(async () => { await result.current.pickRecent('b::3::4'); }));

  expect(changes).toBe(1);
  expect(store.getState().activeFileId).toBe('b::3::4');
  expect(store.getState().runKey).toBe('b::3::4');
});

test('getTaskData memoizes through taskDataCache', async () => {
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  const a = await result.current.getTaskData(1);
  expect(a.fieldNames).toEqual(['duration']);
  expect(store.getState().taskDataCache.get(1)).toBeTruthy();
});

// DropZone and Dashboard each call `useIngest()` as separate instances; the
// worker client must be shared across them (not a per-instance ref) so
// Dashboard's `getTaskData` reaches the client DropZone started the load with.
// `getTaskData` from an instance whose own client was never set must still reach
// the client started by another instance (CoreUsageHistogram depends on this).
test('getTaskData from a second, independently-mounted useIngest() instance still reaches the client started by the first', async () => {
  const { result: dropZone } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => dropZone.current.startLoad(new File(['x'], 'log')));

  // Mirrors Dashboard mounting fresh after `status` flips to 'ready': a
  // brand-new component instance with no props/state shared with DropZone's.
  const { result: dashboard } = renderHook(() => useIngest());
  const data = await dashboard.current.getTaskData(999);
  expect(data.fieldNames).toEqual(['duration']);
});

test('cancelParse abandons a mid-parse run without caching a snapshot for it', () => {
  const client = fakeClient();
  client.startParse = (_f: File, h: any) => {
    h.onApp({ name: 'demo', id: 'app-1' });
    h.onStage({ stageId: 1, name: 's1' });
  };
  store.setState({ ...store.getState(), run: null, runKey: null, status: 'idle', sessionCache: new Map() });
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoad(new File(['x'], 'log'), { id: 'recent-1' }));
  expect(store.getState().status).toBe('parsing');
  expect(store.getState().run).toBeNull();

  act(() => result.current.cancelParse());

  expect(client.terminate).toHaveBeenCalled();
  expect(store.getState().sessionCache.has('recent-1')).toBe(false);
  expect(store.getState().activeFileId).toBeNull();
  expect(selectAppModel(store.getState()).app).toBeNull();
  expect(store.getState().status).toBe('idle');
});
