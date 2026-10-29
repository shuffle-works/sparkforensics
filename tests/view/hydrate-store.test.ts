// @vitest-environment jsdom
import { test, expect, beforeEach, vi } from 'vitest';
import { gzipSync } from 'node:zlib';
import { store, selectAppModel, selectCatalog, selectConfigFindings } from '@/store/store';
import { hydrateExportStore, loadExportPayload, unsupportedPayloadReason } from '@/export/hydrate-store';
import { EXPORT_DATA_SCHEMA_VERSION, type ExportRunData, type ExportRunDataV3 } from '@sparkforensics/core/export-data.ts';
import type { Finding } from '@sparkforensics/core/types.ts';
import { interpretationOf } from '@/view/interpretation';
import { testFinding } from './_shared/finding';
import { makeRun } from './_shared/run';

beforeEach(() => {
  store.getState().resetModel();
});

const CATALOG: Finding[] = [testFinding({ type: 'skew', stageId: 1, impactBand: 'warning' })];
const CONFIG_FINDINGS: Finding[] = [testFinding({ type: 'configAudit', property: 'spark.sql.shuffle.partitions', valueText: '200', impactBand: 'info' })];

// What a producer computed (it also gives each finding above its id), with a title no core would
// write, so a test can tell the payload's conclusion from one derived again at open time.
function producerInterpretation() {
  const { interpretation } = makeRun({ catalog: CATALOG, configFindings: CONFIG_FINDINGS });
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
    unreadableSqlExecutions: null,
    taskData: null,
    interpretation: producerInterpretation(),
    ...overrides,
  };
}

test('rebuilds the store\'s Maps keyed the way the rest of the app expects', () => {
  hydrateExportStore(sampleData());
  const appModel = selectAppModel(store.getState());
  expect(appModel.stages).toBeInstanceOf(Map);
  expect(appModel.stages.get(1)).toEqual({ id: 1, name: 's1' });
  expect(appModel.jobs.get(1)?.id).toBe(1);
  expect(appModel.sql.get(1)?.id).toBe(1);
});

test('sets catalog, configFindings, skippedLines, status, and exportMode', () => {
  hydrateExportStore(sampleData());
  const s = store.getState();
  expect(selectCatalog(s)).toEqual(CATALOG);
  expect(selectConfigFindings(s)).toEqual(CONFIG_FINDINGS);
  expect(selectAppModel(s).skippedLines).toBe(2);
  expect(s.status).toBe('ready');
  expect(s.exportMode).toBe(true);
});

test('carries app-level fields (runAggregates, evidenceAvailability) straight through', () => {
  const data = sampleData({ runAggregates: { coreHistogram: [1, 2, 3] }, evidenceAvailability: { schemaVersion: 1, entries: [] } });
  hydrateExportStore(data);
  const appModel = selectAppModel(store.getState());
  expect(appModel.runAggregates).toEqual({ coreHistogram: [1, 2, 3] });
  expect(appModel.evidenceAvailability).toEqual({ schemaVersion: 1, entries: [] });
});

test('installs the payload\'s interpretation as is, indexing the store\'s own finding objects', () => {
  hydrateExportStore(sampleData());
  const state = store.getState();
  const catalog = selectCatalog(state);
  const configFindings = selectConfigFindings(state);
  const interpretation = interpretationOf(state.run!);
  expect(interpretation.data.verdict.title).toBe('Stamped by the producer');
  // Catalog then config: the order the producer interpreted them in.
  expect(interpretation.findings[0]).toBe(catalog[0]);
  expect(interpretation.findings[1]).toBe(configFindings[0]);
});

// A version 3 file names findings by their position (catalog, then config findings) where this
// version names them by id.
function versionThreeData(): ExportRunDataV3 {
  const base = sampleData();
  const ids = [...base.catalog, ...base.configFindings].map((finding) => finding.id!);
  const at = (id: string) => ids.indexOf(id);
  const { interpretation } = base;
  const { taskData: _taskData, unreadableSqlExecutions: _unreadable, ...rest } = base;
  return {
    ...rest,
    schemaVersion: 3,
    interpretation: {
      ...interpretation,
      savings: ids.map((id) => interpretation.savings[id]),
      verdict: {
        ...interpretation.verdict,
        steps: interpretation.verdict.steps.map(({ leadId, ...step }) => ({ ...step, leadIndex: at(leadId) })),
        costSteps: interpretation.verdict.costSteps.map(({ leadId, ...step }) => ({ ...step, leadIndex: at(leadId) })),
      },
      savingsRank: interpretation.savingsRank.map(at),
      stages: Object.fromEntries(Object.entries(interpretation.stages).map(([stageId, { findingIds, ...stage }]) => [
        stageId, { ...stage, findingIndexes: findingIds.map(at) },
      ])),
      rollup: {
        eligibleIndexes: interpretation.rollup.eligibleIds.map(at),
        groups: interpretation.rollup.groups.map(({ memberIds, ...group }) => ({ ...group, memberIndexes: memberIds.map(at) })),
      },
    },
  } as ExportRunDataV3;
}

test('reads a version 3 payload, pointing its interpretation at the findings by id', () => {
  const data = versionThreeData();
  expect(unsupportedPayloadReason(data)).toBeNull();
  hydrateExportStore(data);
  const state = store.getState();
  const interpretation = interpretationOf(state.run!);
  expect(interpretation.data.verdict.title).toBe('Stamped by the producer');
  const [eligible] = interpretation.data.rollup.eligibleIds;
  expect(interpretation.byId.get(eligible)).toBe(selectCatalog(state)[0]);
  expect(state.run!.taskData).toEqual({ kind: 'none' });
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
  // Version 2 findings carried their text in `value` (stageFailed, configAudit, incompleteRun),
  // not `valueText`, and could omit planNodeIds: this bundle can't render one.
  expect(EXPORT_DATA_SCHEMA_VERSION).toBe(4);
  expect(unsupportedPayloadReason({ ...sampleData(), schemaVersion: 2 })).toContain('version 2');
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

test('unsupportedPayloadReason refuses a payload whose stage, SQL or job lists are not arrays', () => {
  expect(unsupportedPayloadReason({ ...sampleData(), stages: undefined })).toContain('stage list');
  expect(unsupportedPayloadReason({ ...sampleData(), sql: null })).toContain('SQL execution list');
  expect(unsupportedPayloadReason({ ...sampleData(), jobs: {} })).toContain('job list');
});

const encodePayload = (data: unknown) => gzipSync(JSON.stringify(data)).toString('base64');

test('loadExportPayload hydrates a readable payload and returns no refusal', () => {
  expect(loadExportPayload(encodePayload(sampleData()))).toBeNull();
  expect(store.getState().status).toBe('ready');
});

test('loadExportPayload reports a missing data.js instead of throwing', () => {
  for (const missing of [undefined, null, '', 42]) {
    expect(loadExportPayload(missing)).toContain('data.js');
  }
  expect(store.getState().status).not.toBe('ready');
});

test('loadExportPayload reports a truncated or corrupt payload instead of throwing', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const encoded = encodePayload(sampleData());
  expect(loadExportPayload(encoded.slice(0, Math.floor(encoded.length / 2)))).toContain('missing or unreadable');
  expect(loadExportPayload('not base64 at all !!')).toContain('missing or unreadable');
  expect(loadExportPayload(encodePayload('{"not":"a payload"}').slice(0, 20))).toContain('missing or unreadable');
});

test('loadExportPayload keeps the version refusal for a payload of another version', () => {
  expect(loadExportPayload(encodePayload({ ...sampleData(), schemaVersion: 1 }))).toContain('version 1');
});

test('loadExportPayload reports a payload that fails while hydrating', () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const damaged = { ...sampleData(), stages: [null] };
  expect(loadExportPayload(encodePayload(damaged))).toContain('missing or unreadable');
});
