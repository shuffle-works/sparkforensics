import { describe, it, expect } from 'vitest';
import {
  buildExportRunData, CORE_VERSION, EXPORT_DATA_SCHEMA_VERSION, reviveExportCollections,
} from '../src/export-data.js';
import { makeStage, makeApp } from './fixtures/stage-app-fixtures.js';
import { buildHtmlExportData, encodeRunPayload } from '../src/html-export.js';
import { runPayloadScript } from '../src/run-payload.js';
import { analyze, auditConfig } from '../src/analyzer.js';
import { TRUNCATED_HOST, TRUNCATED_HOST_FRAGMENT, truncatedFailureRun } from './fixtures/truncated-failure-run.js';
import { interpretRun } from '../src/run-interpretation.js';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';

const PROVENANCE = { coreVersion: CORE_VERSION, buildId: 'abc123', producer: 'test-producer 1.0.0' };

// buildExportRunData with the interpretation and provenance a producer would pass.
function exportData(appModel, catalog = [], configFindings = [], skippedLines = 0) {
  return buildExportRunData(
    appModel, catalog, configFindings, skippedLines, interpretRun(appModel, catalog, configFindings), PROVENANCE,
  );
}

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
    const data = exportData(appModel, catalog, configFindings, 2);

    expect(data.schemaVersion).toBe(EXPORT_DATA_SCHEMA_VERSION);
    expect(data.app).toEqual(appModel.app);
    expect(data.stages).toEqual([appModel.stages.get(1)]);
    expect(data.jobs).toEqual([appModel.jobs.get(1)]);
    expect(data.sql).toEqual([]);
    expect(data.executors).toEqual(appModel.executors);
    expect(data.catalog).toEqual(catalog);
    expect(data.configFindings).toEqual(configFindings);
    expect(data.skippedLines).toBe(2);
    expect(data.provenance).toEqual(PROVENANCE);
    expect(data.interpretation).toEqual(interpretRun(appModel, catalog, configFindings));
  });

  it('is JSON-round-trippable (Maps become plain arrays, not objects with numeric keys)', () => {
    const appModel = makeAppModel();
    const data = exportData(appModel);
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
    const json = JSON.stringify(exportData(appModel));
    expect(JSON.parse(json).app.rddInfo).not.toEqual({});

    const revived = JSON.parse(json, reviveExportCollections);
    expect(revived.app.rddInfo).toBeInstanceOf(Map);
    expect([...revived.app.rddInfo.values()]).toEqual([...rddInfo.values()]);
    expect(revived.stages[0].executorMetrics).toEqual(executorMetrics);
    expect(JSON.parse(JSON.stringify({ tags: new Set(['a']) }), reviveExportCollections).tags).toEqual({});
    expect(JSON.parse(JSON.stringify(exportData(makeAppModel({ app: { ...makeApp(), tags: new Set(['a', 'b']) } }))), reviveExportCollections).app.tags)
      .toEqual(new Set(['a', 'b']));
  });
});

describe('html-export (shared by the CLI --export-html and the dashboard download)', () => {
  it('buildHtmlExportData carries the config audit, the interpretation and provenance, and redacts only when asked', () => {
    const appModel = makeAppModel({ app: makeApp({ id: 'application_42', config: { 'spark.executor.memory': '1g' } }) });
    const stamp = { buildId: 'abc123', producer: 'test-producer 1.0.0' };
    const raw = buildHtmlExportData(appModel, [], 3, { redact: false, ...stamp });
    expect(raw).toEqual(exportData(appModel, [], auditConfig(appModel.app), 3));

    const redacted = buildHtmlExportData(appModel, [], 3, { redact: true, ...stamp });
    expect(redacted.app.id).toBe('app-1');
    expect(JSON.stringify(redacted)).not.toContain('application_42');
  });

  it('redacts the interpretation\'s text with the same pseudonyms as the findings it quotes', () => {
    const appModel = makeAppModel({
      jobs: new Map([[1, {
        id: 1, submissionTime: 0, stageIds: [1], sqlExecutionId: null,
        result: 'JobFailed', succeeded: false, exception: null, completionTime: 1000,
      }]]),
    });
    const stageFailed = {
      type: 'stageFailed', stageId: 1, impactBand: 'critical', recommendation: 'Inspect the driver log.',
      value: 'Lost executor on ip-10-1-2-3.ec2.internal', id: 'f1',
    };
    const data = buildHtmlExportData(appModel, [stageFailed], 0, { redact: true, buildId: 'b', producer: 'p' });

    expect(JSON.stringify(data)).not.toContain('ip-10-1-2-3');
    expect(data.interpretation.verdict.failureReason).toBe(data.catalog[0].value);
    expect(data.interpretation.verdict.steps[0].copyText).toContain(data.catalog[0].value);
  });

  it('redacts before interpreting, so a failure reason cut mid-host keeps no fragment of it', () => {
    const appModel = truncatedFailureRun();
    const catalog = analyze(appModel.app, appModel.stages, [], [], appModel.jobs, appModel.sql, null);
    const data = buildHtmlExportData(appModel, catalog, 0, { redact: true, buildId: 'b', producer: 'p' });
    const { verdict } = data.interpretation;

    expect(verdict.failureReason).toMatch(/\.\.\.$/);
    expect(verdict.failureReason).toContain(' executor on host-');
    expect(JSON.stringify(data)).not.toContain(TRUNCATED_HOST_FRAGMENT);
    // Unredacted, the same run does quote the fragment: the cut is really exercised.
    const raw = buildHtmlExportData(appModel, catalog, 0, { redact: false, buildId: 'b', producer: 'p' });
    expect(raw.interpretation.verdict.failureReason).toContain(TRUNCATED_HOST_FRAGMENT);
    expect(raw.interpretation.verdict.failureReason).not.toContain(TRUNCATED_HOST);
  });

  it('stamps a CORE_VERSION kept equal to packages/core/package.json', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    expect(CORE_VERSION).toBe(pkg.version);
  });

  it('encodeRunPayload is gzip + base64 that Node zlib reads back, across several base64 slices', () => {
    const appModel = makeAppModel({
      stages: new Map(Array.from({ length: 3000 }, (_, i) => [i, makeStage({ id: i, name: `s${i}-${Math.random()}` })])),
    });
    const data = exportData(appModel);
    const base64 = encodeRunPayload(data);
    expect(base64.length).toBeGreaterThan(0x8000 * 2);
    expect(base64).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(JSON.parse(gunzipSync(Buffer.from(base64, 'base64')).toString('utf8'))).toEqual(JSON.parse(JSON.stringify(data)));
  });

  it('runPayloadScript assigns the payload global the export app reads', () => {
    expect(runPayloadScript('QUJD')).toBe('window.__SPARKFORENSICS_RUN_GZ__ = "QUJD";');
  });
});
