// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { store, emptyAppModel } from '@/store/store';
import { hydrateExportStore, unsupportedPayloadReason } from '@/export/hydrate-store';
import { EXPORT_DATA_SCHEMA_VERSION, type ExportRunData } from '@sparkforensics/core/export-data.ts';
import { interpretRun } from '@sparkforensics/core/run-interpretation.ts';
import type { Finding } from '@sparkforensics/core/types.ts';

beforeEach(() => {
  store.getState().resetModel();
  store.setState({ appModel: emptyAppModel() });
});

const CATALOG: Finding[] = [{ type: 'skew', stageId: 1, impactBand: 'warning' }];
const CONFIG_FINDINGS: Finding[] = [{ type: 'configAudit', property: 'spark.sql.shuffle.partitions', impactBand: 'info' }];

// What a producer computed, with a title no core would write, so a test can
// tell the payload's conclusion from one derived again at open time.
function producerInterpretation() {
  const interpretation = interpretRun(emptyAppModel(), CATALOG, CONFIG_FINDINGS);
  return { ...interpretation, verdict: { ...interpretation.verdict, title: 'Stamped by the producer' } };
}

function sampleData(overrides: Partial<ExportRunData> = {}): ExportRunData {
  return {
    schemaVersion: EXPORT_DATA_SCHEMA_VERSION,
    provenance: { coreVersion: '0.1.0', buildId: 'abc123', producer: 'sparkforensics-analyze 9.9.9' },
    app: { id: 'app-1', name: 'Test App', sparkVersion: '3.5.0' },
    stages: [{ id: 1, name: 's1' }],
    jobs: [{ id: 1, submissionTime: 0, stageIds: [1], sqlExecutionId: null, result: null, succeeded: true, exception: null, completionTime: 1000 }],
    sql: [{ id: 1, planTree: null }],
    executors: { added: [], removed: [] },
    runAggregates: null,
    evidenceAvailability: null,
    catalog: structuredClone(CATALOG),
    configFindings: structuredClone(CONFIG_FINDINGS),
    skippedLines: 2,
    interpretation: producerInterpretation(),
    ...overrides,
  };
}

test('rebuilds the store\'s Maps keyed the way the rest of the app expects', () => {
  hydrateExportStore(sampleData());
  const { appModel } = store.getState();
  expect(appModel.stages).toBeInstanceOf(Map);
  expect(appModel.stages.get(1)).toEqual({ id: 1, name: 's1' });
  expect(appModel.jobs.get(1)?.id).toBe(1);
  expect(appModel.sql.get(1)?.id).toBe(1);
});

test('sets catalog, configFindings, skippedLines, status, and exportMode', () => {
  hydrateExportStore(sampleData());
  const s = store.getState();
  expect(s.catalog).toEqual([{ type: 'skew', stageId: 1, impactBand: 'warning' }]);
  expect(s.configFindings).toEqual([{ type: 'configAudit', property: 'spark.sql.shuffle.partitions', impactBand: 'info' }]);
  expect(s.skippedLines).toBe(2);
  expect(s.status).toBe('ready');
  expect(s.exportMode).toBe(true);
});

test('carries app-level fields (runAggregates, evidenceAvailability) straight through', () => {
  const data = sampleData({ runAggregates: { coreHistogram: [1, 2, 3] }, evidenceAvailability: { schemaVersion: 1, entries: [] } });
  hydrateExportStore(data);
  const { appModel } = store.getState();
  expect(appModel.runAggregates).toEqual({ coreHistogram: [1, 2, 3] });
  expect(appModel.evidenceAvailability).toEqual({ schemaVersion: 1, entries: [] });
});

test('installs the payload\'s interpretation as is, indexing the store\'s own finding objects', () => {
  hydrateExportStore(sampleData());
  const { interpretation, catalog, configFindings } = store.getState();
  expect(interpretation?.data.verdict.title).toBe('Stamped by the producer');
  // Catalog then config: the order the producer interpreted them in.
  expect(interpretation?.findings[0]).toBe(catalog[0]);
  expect(interpretation?.findings[1]).toBe(configFindings[0]);
});

test('keeps the provenance stamp for the footer', () => {
  hydrateExportStore(sampleData());
  expect(store.getState().exportProvenance).toEqual({ coreVersion: '0.1.0', buildId: 'abc123', producer: 'sparkforensics-analyze 9.9.9' });
});

test('accepts only the payload version this bundle was built for', () => {
  expect(unsupportedPayloadReason(sampleData())).toBeNull();
  const older = unsupportedPayloadReason({ ...sampleData(), schemaVersion: 1 });
  expect(older).toContain('version 1');
  expect(older).toContain(`only reads version ${EXPORT_DATA_SCHEMA_VERSION}`);
  expect(unsupportedPayloadReason({ ...sampleData(), schemaVersion: EXPORT_DATA_SCHEMA_VERSION + 1 }))
    .toContain(`version ${EXPORT_DATA_SCHEMA_VERSION + 1}`);
  expect(unsupportedPayloadReason({ app: null })).toContain('an unknown version');
  expect(unsupportedPayloadReason(null)).toContain('an unknown version');
});

test('refuses a payload of the right version that lacks a precomputed result', () => {
  const { configFindings: _config, ...withoutConfig } = sampleData();
  expect(unsupportedPayloadReason(withoutConfig)).toContain('missing the config audit results');
  expect(unsupportedPayloadReason({ ...sampleData(), configFindings: null })).toContain('missing the config audit results');
  const { interpretation: _interpretation, ...withoutInterpretation } = sampleData();
  expect(unsupportedPayloadReason(withoutInterpretation)).toContain('missing the run interpretation');
  expect(unsupportedPayloadReason({ ...sampleData(), interpretation: [] })).toContain('missing the run interpretation');
  expect(unsupportedPayloadReason({ ...sampleData(), configFindings: undefined, interpretation: null }))
    .toContain('missing the config audit results and run interpretation');
});
