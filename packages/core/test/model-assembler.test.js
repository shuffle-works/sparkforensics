import { describe, it, expect, vi } from 'vitest';
import { createModelCallbacks } from '../src/model-assembler.js';

describe('createModelCallbacks', () => {
  it('assembles stages and sql into appModel', () => {
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map() };
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    cb.onApp({ name: 'A' });
    cb.onStage({ id: 1 });
    cb.onSql({ id: 7, physicalPlanDescription: '', stageIds: [1] });
    expect(appModel.app.name).toBe('A');
    expect(appModel.stages.get(1)).toBeTruthy();
    expect(appModel.stages.get(1).sqlExecutionId).toBe(7);
    expect(appModel.sql.get(7)).toBeTruthy();
  });

  it('patches per-stage executorMetrics from the pre-done stageExecutorMetrics message', () => {
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map() };
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    // Stage posted at completion time with an empty map (the real-order bug).
    cb.onStage({ id: 1, executorMetrics: new Map() });
    expect(appModel.stages.get(1).executorMetrics.size).toBe(0);
    cb.onStageExecutorMetrics(new Map([[1, new Map([['7', { jvmHeapMemory: 99 }]])]]));
    expect(appModel.stages.get(1).executorMetrics.get('7')).toEqual({ jvmHeapMemory: 99 });
  });

  it('ignores stageExecutorMetrics for unknown stage ids without throwing', () => {
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map() };
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    expect(() => cb.onStageExecutorMetrics(new Map([[999, new Map()]]))).not.toThrow();
  });

  it('keeps compact app evidence inputs on the normal app update path', () => {
    const appModel = { app: null, stages: new Map(), executors: { added: [], removed: [] }, sql: new Map(), jobs: new Map(), runAggregates: null };
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    const evidenceInputs = {
      environmentUpdates: 1, applicationEnds: 1, stageSubmissions: 2, rddStorageSnapshots: 3,
      sqlExecutions: 4, resolvedSqlPlans: 5, executorMetricRows: 6, taskRecords: 7,
    };

    cb.onApp({ name: 'A', evidenceInputs });
    cb.onRunAggregates({ perStage: { 1: { taskCount: 7 } } });

    expect(appModel.app).toEqual({ name: 'A', evidenceInputs });
    expect(appModel.runAggregates).toEqual({ perStage: { 1: { taskCount: 7 } } });
  });
});
