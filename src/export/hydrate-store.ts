import { store } from '@/store/store';
import { reviveExportCollections, type ExportRunData } from '@sparkforensics/core/export-data.ts';
import { applySnapshot } from '@sparkforensics/core/session-snapshot.ts';
import type { SessionSnapshot } from '@sparkforensics/core/session-snapshot.ts';
import { gunzipSync, strFromU8 } from '@sparkforensics/core/vendor/fflate.js';

/** Reverses the CLI's write-time encoding of data.js (base64-decode, gunzip,
 * UTF-8-decode, JSON.parse with nested Maps and Sets revived). strFromU8's second arg must stay falsy: the
 * payload can contain non-ASCII free text (e.g. Spanish app/stage names) that
 * only decodes correctly as UTF-8, fflate's default. */
export function decodeRunPayload(base64: string): ExportRunData {
  const compressed = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const json = strFromU8(gunzipSync(compressed));
  return JSON.parse(json, reviveExportCollections) as ExportRunData;
}

/** Rebuilds the store's Map-based AppModel from the CLI-serialized data.js
 * payload and flips the store to `exportMode` (evidence/analyze/auditConfig
 * are precomputed server-side). Split out of main-export.tsx so it's testable
 * without mounting React.
 *
 * Reuses session-snapshot.ts's applySnapshot (the same restore path
 * useIngest.ts uses when switching to an already-parsed file) rather than
 * hand-rolling the array-to-Map rebuild again, so the two paths can't drift.
 * ExportRunData is SessionSnapshot minus taskData plus
 * configFindings/skippedLines, which applySnapshot doesn't handle and are set
 * separately below. */
export function hydrateExportStore(data: ExportRunData): void {
  const snapshot: SessionSnapshot = {
    app: data.app,
    stages: new Map(data.stages.map((s) => [s.id, s])),
    executors: data.executors,
    // Keyed by SqlExecution.id, matching onSql (model-assembler.ts) and the
    // field buildExportRunData serializes into data.sql.
    sql: new Map(data.sql.map((e) => [e.id, e])),
    jobs: new Map(data.jobs.map((j) => [j.id, j])),
    runAggregates: data.runAggregates,
    evidenceAvailability: data.evidenceAvailability,
    catalog: data.catalog,
    taskData: new Map(),
  };

  // applySnapshot mutates the store's boot-time appModel/taskDataCache in
  // place and returns the catalog to install.
  const s = store.getState();
  const catalog = applySnapshot(s.appModel, s.taskDataCache, snapshot);
  store.setState({ exportMode: true });
  store.getState().setCatalog(catalog);
  store.getState().setConfigFindings(data.configFindings);
  store.getState().setSkippedLines(data.skippedLines);
  store.getState().setStatus('ready');
}
