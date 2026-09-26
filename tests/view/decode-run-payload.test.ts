// @vitest-environment jsdom
import { test, expect } from 'vitest';
import { gzipSync } from 'node:zlib';
import { decodeRunPayload } from '@/export/hydrate-store';
import { buildExportRunData, type ExportRunData } from '@sparkforensics/core/export-data.ts';
import type { AppModel } from '@sparkforensics/core/types.ts';
import { emptyAppModel } from '@/store/store';

function sampleData(overrides: Partial<ExportRunData> = {}): ExportRunData {
  return {
    schemaVersion: 1,
    app: { id: 'app-1', name: 'Consulta de facturación', sparkVersion: '3.5.0' },
    stages: [{ id: 1, name: 's1' }],
    jobs: [],
    sql: [],
    executors: { added: [], removed: [] },
    runAggregates: null,
    evidenceAvailability: null,
    catalog: [],
    configFindings: [],
    skippedLines: 0,
    ...overrides,
  } as unknown as ExportRunData;
}

// base64-encode a Node-produced gzip buffer the same way writeHtmlExport
// (packages/cli/bin/sparkforensics-analyze.mjs) does at write time.
function encode(data: ExportRunData): string {
  return gzipSync(JSON.stringify(data)).toString('base64');
}

test('round-trips a gzip+base64 payload produced by Node\'s zlib.gzipSync', () => {
  const data = sampleData();
  const decoded = decodeRunPayload(encode(data));
  expect(decoded).toEqual(data);
});

test('decodes non-ASCII text as UTF-8, not latin1', () => {
  // "facturación" has a non-ASCII character (ó): a latin1 decode of its
  // UTF-8 bytes would corrupt it into mojibake instead of round-tripping.
  const data = sampleData({
    stages: [{ id: 1, name: 'Cálculo de ratón: órdenes de España' } as ExportRunData['stages'][number]],
  });
  const decoded = decodeRunPayload(encode(data));
  expect(decoded.stages[0].name).toBe('Cálculo de ratón: órdenes de España');
  expect(decoded.app?.name).toBe('Consulta de facturación');
});

test('revives the Maps the CLI tags, so a widget can call .values() on app.rddInfo', () => {
  const rddInfo = new Map([[3, { id: 3, name: 'cached', stageIds: [1] }]]);
  const data = buildExportRunData(
    { ...emptyAppModel(), app: { id: 'app-1', rddInfo } as unknown as AppModel['app'] },
    [], [], 0,
  );
  const decoded = decodeRunPayload(encode(data));
  expect(decoded.app?.rddInfo).toBeInstanceOf(Map);
  expect([...(decoded.app!.rddInfo as Map<number, unknown>).values()]).toEqual([...rddInfo.values()]);
});
