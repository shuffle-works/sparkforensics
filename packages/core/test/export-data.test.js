import { describe, it, expect } from 'vitest';
import { buildExportRunData, EXPORT_DATA_SCHEMA_VERSION } from '../src/export-data.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';

function makeAppModel(overrides = {}) {
  return {
    app: makeApp(),
    stages: new Map([[1, makeStage({ id: 1 })]]),
    executors: { added: [], removed: [] },
    sql: new Map(),
    jobs: new Map([[1, {
      id: 1, submissionTime: 0, stageIds: [1], sqlExecutionId: null,
      result: null, succeeded: true, exception: null, completionTime: 1000,
    }]]),
    runAggregates: null,
    evidenceAvailability: null,
    ...overrides,
  };
}

describe('buildExportRunData', () => {
  it('converts the Map-based AppModel into plain arrays keyed the same way the store rebuilds them', () => {
    const appModel = makeAppModel();
    const catalog = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];
    const configFindings = [{ type: 'configAudit', property: 'spark.sql.shuffle.partitions', impactBand: 'info' }];
    const data = buildExportRunData(appModel, catalog, configFindings, 2);

    expect(data.schemaVersion).toBe(EXPORT_DATA_SCHEMA_VERSION);
    expect(data.app).toEqual(appModel.app);
    expect(data.stages).toEqual([appModel.stages.get(1)]);
    expect(data.jobs).toEqual([appModel.jobs.get(1)]);
    expect(data.sql).toEqual([]);
    expect(data.executors).toBe(appModel.executors);
    expect(data.catalog).toBe(catalog);
    expect(data.configFindings).toBe(configFindings);
    expect(data.skippedLines).toBe(2);
  });

  it('is JSON-round-trippable (Maps become plain arrays, not objects with numeric keys)', () => {
    const appModel = makeAppModel();
    const data = buildExportRunData(appModel, [], [], 0);
    const roundTripped = JSON.parse(JSON.stringify(data));
    expect(Array.isArray(roundTripped.stages)).toBe(true);
    expect(roundTripped.stages).toEqual(data.stages);
  });
});
