// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { store, selectAppModel, selectCatalog, selectConfigFindings, EMPTY_APP_MODEL } from '../../src/store/store';
import { makeRun } from './_shared/run';

beforeEach(() => store.setState({ ...store.getState(), run: null, runKey: null }));

test('installRun installs the run under its key and marks the store ready', () => {
  const run = makeRun({ catalog: [{ type: 'skew', stageId: 1, impactBand: 'critical' }] });
  store.getState().installRun(run, 'run-1');
  expect(store.getState().run).toBe(run);
  expect(store.getState().runKey).toBe('run-1');
  expect(store.getState().status).toBe('ready');
  expect(selectCatalog(store.getState())).toHaveLength(1);
  expect(selectAppModel(store.getState())).toBe(run.appModel); // identity unchanged
});

test('installRun seeds the task data cache from a snapshot run and empties it for any other', () => {
  const stages = new Map([[7, { metrics: [1, 2], fieldNames: ['duration', 'gcTime'] }]]);
  store.getState().installRun(makeRun({ taskData: { kind: 'snapshot', stages } }), 'run-1');
  expect(store.getState().taskDataCache.get(7)?.fieldNames).toEqual(['duration', 'gcTime']);

  store.getState().installRun(makeRun({ taskData: { kind: 'none' } }), 'run-2');
  expect(store.getState().taskDataCache.size).toBe(0);
});

test('the selectors read an empty model and no findings until a run is installed', () => {
  expect(selectAppModel(store.getState())).toBe(EMPTY_APP_MODEL);
  expect(selectCatalog(store.getState())).toEqual([]);
  expect(selectConfigFindings(store.getState())).toEqual([]);
});

test('setTaskData fills the lazy cache without replacing the map identity contract', () => {
  store.getState().setTaskData(7, { metrics: [1, 2], fieldNames: ['duration', 'gcTime'] });
  expect(store.getState().taskDataCache.get(7)?.fieldNames).toEqual(['duration', 'gcTime']);
});

test('setTaskDataBatch adds every entry in one state update', () => {
  let updates = 0;
  const unsubscribe = store.subscribe(() => { updates++; });
  store.getState().setTaskDataBatch([
    [1, { metrics: [1], fieldNames: ['duration'] }],
    [2, { metrics: [2], fieldNames: ['duration'] }],
    [3, { metrics: [3], fieldNames: ['duration'] }],
  ]);
  unsubscribe();
  expect(updates).toBe(1);
  expect(store.getState().taskDataCache.get(2)?.metrics).toEqual([2]);
  const before = store.getState().taskDataCache;
  store.getState().setTaskDataBatch([]);
  expect(store.getState().taskDataCache).toBe(before);
});

test('resetModel clears the run, its key and the caches', () => {
  store.getState().installRun(makeRun({ catalog: [{ type: 'gc', stageId: 2, impactBand: 'warning' }] }), 'run-1');
  store.getState().setTaskData(7, { metrics: [1], fieldNames: ['duration'] });
  store.getState().resetModel();
  expect(store.getState().run).toBeNull();
  expect(store.getState().runKey).toBeNull();
  expect(store.getState().taskDataCache.size).toBe(0);
  expect(selectCatalog(store.getState())).toEqual([]);
  expect(selectConfigFindings(store.getState())).toEqual([]);
  expect(selectAppModel(store.getState()).stages.size).toBe(0);
});

test('openPlanGraph sets planGraph.active and stageId', () => {
  store.getState().openPlanGraph(42);
  expect(store.getState().planGraph).toEqual({ active: true, stageId: 42, initialScope: 'segment' });
});

test('closePlanGraph resets planGraph to inactive', () => {
  store.getState().openPlanGraph(42);
  store.getState().closePlanGraph();
  expect(store.getState().planGraph).toEqual({ active: false, stageId: null, initialScope: 'segment' });
});

test('resetModel clears planGraph alongside catalog', () => {
  store.getState().openPlanGraph(42);
  store.getState().resetModel();
  expect(store.getState().planGraph).toEqual({ active: false, stageId: null, initialScope: 'segment' });
});

test('openPlanGraph defaults initialScope to "segment" when no options are given', () => {
  store.getState().openPlanGraph(42);
  expect(store.getState().planGraph).toEqual({ active: true, stageId: 42, initialScope: 'segment' });
});

test('openPlanGraph sets initialScope to "full" when requested', () => {
  store.getState().openPlanGraph(42, { initialScope: 'full' });
  expect(store.getState().planGraph).toEqual({ active: true, stageId: 42, initialScope: 'full' });
});
