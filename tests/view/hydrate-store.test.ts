// @vitest-environment jsdom
import { test, expect, beforeEach } from 'vitest';
import { store, emptyAppModel } from '@/store/store';
import { hydrateExportStore } from '@/export/hydrate-store';
import type { ExportRunData } from '@sparkforensics/core/export-data.ts';

beforeEach(() => {
  store.getState().resetModel();
  store.setState({ appModel: emptyAppModel() });
});

function sampleData(overrides: Partial<ExportRunData> = {}): ExportRunData {
  return {
    schemaVersion: 1,
    app: { id: 'app-1', name: 'Test App', sparkVersion: '3.5.0' },
    stages: [{ id: 1, name: 's1' }],
    jobs: [{ id: 1, submissionTime: 0, stageIds: [1], sqlExecutionId: null, result: null, succeeded: true, exception: null, completionTime: 1000 }],
    sql: [{ id: 1, planTree: null }],
    executors: { added: [], removed: [] },
    runAggregates: null,
    evidenceAvailability: null,
    catalog: [{ type: 'skew', stageId: 1, impactBand: 'warning' }],
    configFindings: [{ type: 'configAudit', property: 'spark.sql.shuffle.partitions', impactBand: 'info' }],
    skippedLines: 2,
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
