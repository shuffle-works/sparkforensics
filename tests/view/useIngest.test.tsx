// @vitest-environment jsdom
import { test, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIngest } from '../../src/store/useIngest';
import { store, emptyAppModel } from '../../src/store/store';
import { captureSnapshot, applySnapshot } from '@sparkforensics/core/session-snapshot.ts';

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
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], status: 'idle', errorMessage: null });
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
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], status: 'idle', shsParsing: false });
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
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], status: 'idle', errorMessage: null });
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
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [] });
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(store.getState().appModel.app?.name).toBe('demo');
  expect(store.getState().appModel.stages.size).toBe(1);
  expect(store.getState().status).toBe('ready');
});

test('startLoad stores the skipped-line count from the done payload', () => {
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], skippedLines: 0 });
  const { result } = renderHook(() =>
    useIngest({ makeClient: () => fakeClient({ skippedLines: 5 }) }),
  );
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(store.getState().skippedLines).toBe(5);
});

test('startLoad resets skippedLines to 0 when the done payload omits it', () => {
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], skippedLines: 7 });
  const { result } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => result.current.startLoad(new File(['x'], 'log')));
  expect(store.getState().skippedLines).toBe(0);
});

test('runDone derives availability before analysis and snapshots it', () => {
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], skippedLines: 0 });
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

  expect(store.getState().appModel.evidenceAvailability?.schemaVersion).toBe(1);
  expect(store.getState().appModel.evidenceAvailability?.entries.find((entry) => entry.key === 'taskCoreTime')).toMatchObject({
    state: 'notEmitted', reasonCode: 'noUsableCoreTimeAggregate',
  });
  expect(store.getState().catalog.every((finding) => finding.type !== 'evidenceAvailability')).toBe(true);
  const snapshot = captureSnapshot(store.getState().appModel, [], new Map());
  const restored = emptyAppModel();
  applySnapshot(restored, new Map(), snapshot);
  expect(restored.evidenceAvailability).toEqual(store.getState().appModel.evidenceAvailability);
});

test('runDone derives configFindings from the app config, once, alongside catalog', () => {
  store.setState({ ...store.getState(), appModel: emptyAppModel(), catalog: [], configFindings: [] });
  const client = fakeClient();
  client.startParse = (_f: File, h: any) => {
    h.onApp({
      name: 'demo', id: 'app-1',
      resources: { dynamicAllocationEnabled: true, shuffleServiceEnabled: false },
    });
    h.onDone({});
  };
  const { result } = renderHook(() => useIngest({ makeClient: () => client }));

  act(() => result.current.startLoad(new File(['x'], 'log')));

  expect(store.getState().configFindings).toContainEqual(
    expect.objectContaining({ type: 'configAudit', property: 'spark.shuffle.service.enabled' }),
  );
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
// Regression: CoreUsageHistogram rendered an empty chart when its `getTaskData`
// came from an instance whose own client was never set.
test('getTaskData from a second, independently-mounted useIngest() instance still reaches the client started by the first', async () => {
  const { result: dropZone } = renderHook(() => useIngest({ makeClient: fakeClient }));
  act(() => dropZone.current.startLoad(new File(['x'], 'log')));

  // Mirrors Dashboard mounting fresh after `status` flips to 'ready': a
  // brand-new component instance with no props/state shared with DropZone's.
  const { result: dashboard } = renderHook(() => useIngest());
  const data = await dashboard.current.getTaskData(999);
  expect(data.fieldNames).toEqual(['duration']);
});
