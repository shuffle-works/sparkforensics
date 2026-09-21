// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { store, emptyAppModel } from '../../src/store/store';

beforeEach(() => store.setState({ ...store.getState(), catalog: [], appModel: emptyAppModel() }));

test('setCatalog updates only catalog slice', () => {
  const before = store.getState().appModel;
  store.getState().setCatalog([{ type: 'skew', stageId: 1, impactBand: 'critical' }]);
  expect(store.getState().catalog).toHaveLength(1);
  expect(store.getState().appModel).toBe(before); // identity unchanged
});

test('setTaskData fills the lazy cache without replacing the map identity contract', () => {
  store.getState().setTaskData(7, { metrics: [1, 2], fieldNames: ['duration', 'gcTime'] });
  expect(store.getState().taskDataCache.get(7)?.fieldNames).toEqual(['duration', 'gcTime']);
});

test('resetModel clears model, catalog and caches', () => {
  store.getState().setCatalog([{ type: 'gc', stageId: 2, impactBand: 'warning' }]);
  store.getState().resetModel();
  expect(store.getState().catalog).toEqual([]);
  expect(store.getState().appModel.stages.size).toBe(0);
});

test('setConfigFindings updates only the configFindings slice', () => {
  const before = store.getState().appModel;
  store.getState().setConfigFindings([{ type: 'configAudit', property: 'spark.serializer', impactBand: 'info', stageId: null }]);
  expect(store.getState().configFindings).toHaveLength(1);
  expect(store.getState().appModel).toBe(before); // identity unchanged
});

test('resetModel clears configFindings alongside catalog', () => {
  store.getState().setConfigFindings([{ type: 'configAudit', property: 'spark.serializer', impactBand: 'info', stageId: null }]);
  store.getState().resetModel();
  expect(store.getState().configFindings).toEqual([]);
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
