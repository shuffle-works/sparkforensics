import { describe, it, expect } from 'vitest';
import { buildExportRunData, EXPORT_DATA_SCHEMA_VERSION, reviveExportCollections } from '../src/export-data.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';
import { buildHtmlExportData, encodeRunPayload, runPayloadScript } from '../src/html-export.js';
import { auditConfig } from '../src/analyzer.js';
import { gunzipSync } from 'node:zlib';

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
    expect(data.executors).toEqual(appModel.executors);
    expect(data.catalog).toEqual(catalog);
    expect(data.configFindings).toEqual(configFindings);
    expect(data.skippedLines).toBe(2);
  });

  it('is JSON-round-trippable (Maps become plain arrays, not objects with numeric keys)', () => {
    const appModel = makeAppModel();
    const data = buildExportRunData(appModel, [], [], 0);
    const roundTripped = JSON.parse(JSON.stringify(data));
    expect(Array.isArray(roundTripped.stages)).toBe(true);
    expect(roundTripped.stages).toEqual(data.stages);
  });

  it('keeps nested Maps and Sets through JSON and back, where plain JSON would leave {}', () => {
    const rddInfo = new Map([[3, { id: 3, name: 'cached', stageIds: [1, 2] }]]);
    const executorMetrics = new Map([['exec-1', { JVMHeapMemory: 10 }]]);
    const appModel = makeAppModel({
      app: { ...makeApp(), rddInfo },
      stages: new Map([[1, makeStage({ id: 1, executorMetrics })]]),
    });
    const json = JSON.stringify(buildExportRunData(appModel, [], [], 0));
    expect(JSON.parse(json).app.rddInfo).not.toEqual({});

    const revived = JSON.parse(json, reviveExportCollections);
    expect(revived.app.rddInfo).toBeInstanceOf(Map);
    expect([...revived.app.rddInfo.values()]).toEqual([...rddInfo.values()]);
    expect(revived.stages[0].executorMetrics).toEqual(executorMetrics);
    expect(JSON.parse(JSON.stringify({ tags: new Set(['a']) }), reviveExportCollections).tags).toEqual({});
    expect(JSON.parse(JSON.stringify(buildExportRunData(makeAppModel({ app: { ...makeApp(), tags: new Set(['a', 'b']) } }), [], [], 0)), reviveExportCollections).app.tags)
      .toEqual(new Set(['a', 'b']));
  });
});

describe('html-export (shared by the CLI --export-html and the dashboard download)', () => {
  it('buildHtmlExportData carries the config audit and redacts only when asked', () => {
    const appModel = makeAppModel({ app: makeApp({ id: 'application_42', config: { 'spark.executor.memory': '1g' } }) });
    const raw = buildHtmlExportData(appModel, [], 3, { redact: false });
    expect(raw).toEqual(buildExportRunData(appModel, [], auditConfig(appModel.app), 3));

    const redacted = buildHtmlExportData(appModel, [], 3, { redact: true });
    expect(redacted.app.id).toBe('app-1');
    expect(JSON.stringify(redacted)).not.toContain('application_42');
  });

  it('encodeRunPayload is gzip + base64 that Node zlib reads back, across several base64 slices', () => {
    const appModel = makeAppModel({
      stages: new Map(Array.from({ length: 3000 }, (_, i) => [i, makeStage({ id: i, name: `s${i}-${Math.random()}` })])),
    });
    const data = buildExportRunData(appModel, [], [], 0);
    const base64 = encodeRunPayload(data);
    expect(base64.length).toBeGreaterThan(0x8000 * 2);
    expect(base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'))).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('runPayloadScript assigns the payload global the export app reads', () => {
    expect(runPayloadScript('QUJD')).toBe('window.__SPARKFORENSICS_RUN_GZ__ = "QUJD";');
  });
});
