import { describe, it, expect, vi } from 'vitest';
import { createModelCallbacks } from '../src/model-assembler.js';
import { emptyAppModel } from '../src/run-serialization.ts';

// The assembler reads only a few stage fields, so a test passes just those.
/** @param {Partial<import('../src/types.ts').Stage>} fields */
const stageOf = (fields) => /** @type {import('../src/types.ts').Stage} */ (fields);

describe('createModelCallbacks', () => {
  it('assembles stages and sql into appModel', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    cb.onApp({ name: 'A' });
    cb.onStage(stageOf({ id: 1 }));
    cb.onSql({ id: 7, stageIds: [1] });
    expect(appModel.app?.name).toBe('A');
    expect(appModel.stages.get(1)).toBeTruthy();
    expect(appModel.stages.get(1)?.sqlExecutionId).toBe(7);
    expect(appModel.sql.get(7)).toBeTruthy();
  });

  it('patches per-stage executorMetrics from the pre-done stageExecutorMetrics message', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    // Stage posted at completion time with an empty map (the real-order bug).
    cb.onStage(stageOf({ id: 1, executorMetrics: new Map() }));
    expect(appModel.stages.get(1)?.executorMetrics?.size).toBe(0);
    cb.onStageExecutorMetrics(new Map([[1, new Map([['7', { jvmHeapMemory: 99 }]])]]));
    expect(appModel.stages.get(1)?.executorMetrics?.get('7')).toEqual({ jvmHeapMemory: 99 });
  });

  it('patches per-stage speculation totals from the pre-done stageSpeculationWaste message', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    cb.onStage(stageOf({ id: 1, speculationWasteMs: 100, speculationWastedAttempts: 1, retryWasteMs: 7 }));
    cb.onStageSpeculationWaste(new Map([[1, { speculationWasteMs: 900, speculationWastedAttempts: 4 }], [999, { speculationWasteMs: 1, speculationWastedAttempts: 1 }]]));
    expect(appModel.stages.get(1)).toMatchObject({ speculationWasteMs: 900, speculationWastedAttempts: 4, retryWasteMs: 7 });
    expect(appModel.stages.has(999)).toBe(false);
  });

  it('ignores stageExecutorMetrics for unknown stage ids without throwing', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    expect(() => cb.onStageExecutorMetrics(new Map([[999, new Map()]]))).not.toThrow();
  });

  it('patches a plan tree onto its sql execution when onSqlPlan arrives after onSql', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    const planTree = { id: '0', name: 'Project', children: [] };
    cb.onSql({ id: 7 });
    cb.onSqlPlan({ executionId: 7, planTree });
    expect(appModel.sql.get(7)?.planTree).toEqual(planTree);
  });

  it('ignores onSqlPlan for an execution id it has not seen without throwing', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    expect(() => cb.onSqlPlan({ executionId: 999, planTree: { id: '0', name: 'Project', children: [] } })).not.toThrow();
    expect(appModel.sql.has(999)).toBe(false);
  });

  it('routes onExecutor events to the added or removed list by kind', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    const added = /** @type {const} */ ({ kind: 'added', timestamp: 0, executorId: '1', host: 'h', totalCores: 4, resourceProfileId: null });
    const removed = /** @type {const} */ ({ kind: 'removed', timestamp: 1, executorId: '1', reason: 'done' });
    cb.onExecutor(added);
    cb.onExecutor(removed);
    expect(appModel.executors.added).toEqual([added]);
    expect(appModel.executors.removed).toEqual([removed]);
  });

  it('assembles jobs by id via onJob', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    const job = { id: 3, submissionTime: null, stageIds: [], sqlExecutionId: null, result: null, succeeded: null, exception: null, completionTime: null };
    cb.onJob(job);
    expect(appModel.jobs.get(3)).toEqual(job);
  });

  it('keeps compact app evidence inputs on the normal app update path', () => {
    const appModel = emptyAppModel();
    const cb = createModelCallbacks(appModel, { onProgress: vi.fn(), onDone: vi.fn(), onError: vi.fn() });
    const evidenceInputs = {
      environmentUpdates: 1, applicationEnds: 1, stageSubmissions: 2, rddStorageSnapshots: 3,
      sqlExecutions: 4, resolvedSqlPlans: 5, executorMetricRows: 6, taskRecords: 7,
    };

    cb.onApp({ name: 'A', evidenceInputs });
    cb.onRunAggregates({ perStage: { 1: { totalTaskDurationSum: 0, taskCount: 7 } } });

    expect(appModel.app).toEqual({ name: 'A', evidenceInputs });
    expect(appModel.runAggregates).toEqual({ perStage: { 1: { totalTaskDurationSum: 0, taskCount: 7 } } });
  });
});
