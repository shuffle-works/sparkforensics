import { store } from '@/store/store';
import {
  EXPORT_DATA_SCHEMA_VERSION, reviveExportCollections, type ExportRunData,
} from '@sparkforensics/core/export-data.ts';
import { applySnapshot } from '@sparkforensics/core/session-snapshot.ts';
import type { SessionSnapshot } from '@sparkforensics/core/session-snapshot.ts';
import { gunzipSync, strFromU8 } from '@sparkforensics/core/vendor/fflate.js';

/** Reverses the CLI's write-time encoding of data.js (base64-decode, gunzip,
 * UTF-8-decode, JSON.parse with nested Maps and Sets revived). strFromU8's second arg must stay falsy: the
 * payload can contain non-ASCII free text (e.g. Spanish app/stage names) that
 * only decodes correctly as UTF-8, fflate's default. */
export function decodeRunPayload(base64: string): unknown {
  const compressed = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const json = strFromU8(gunzipSync(compressed));
  return JSON.parse(json, reviveExportCollections);
}

const REEXPORT_HINT = 'Export the run again with the SparkForensics release you are using now.';

const isObject = (value: unknown): value is object => value != null && typeof value === 'object' && !Array.isArray(value);

/** The precomputed results a payload of this version must carry, since this
 * bundle has no analysis to fill them in, each with how to check it and what
 * to call it in the refusal. */
const REQUIRED_RESULTS: { key: keyof ExportRunData; present: (value: unknown) => boolean; label: string }[] = [
  { key: 'configFindings', present: Array.isArray, label: 'config audit results' },
  { key: 'interpretation', present: isObject, label: 'run interpretation' },
];

/** Why this bundle cannot render `payload`, or null when it can. The bundle
 * renders exactly the payload version it was built for: an older payload lacks
 * the precomputed conclusions (this bundle has no analysis to fill them in),
 * and a newer one may carry fields it would silently drop, so either is refused
 * whole rather than rendered partially. A payload of the right version missing
 * one of its precomputed results is refused the same way. */
export function unsupportedPayloadReason(payload: unknown): string | null {
  const fields: Record<string, unknown> = isObject(payload) ? payload as Record<string, unknown> : {};
  const version = fields.schemaVersion;
  if (version !== EXPORT_DATA_SCHEMA_VERSION) {
    const found = typeof version === 'number' ? `version ${version}` : 'an unknown version';
    return `This file holds export data format ${found}, but this viewer only reads version ${EXPORT_DATA_SCHEMA_VERSION}. ${REEXPORT_HINT}`;
  }
  const missing = REQUIRED_RESULTS.filter(({ key, present }) => !present(fields[key])).map(({ label }) => label);
  if (missing.length === 0) return null;
  return `This file is missing the ${missing.join(' and ')} this viewer needs. ${REEXPORT_HINT}`;
}

/** Rebuilds the store's Map-based AppModel from the CLI-serialized data.js
 * payload and flips the store to `exportMode`. Everything analytical arrives
 * precomputed by the producer: findings, config audit, and the interpretation
 * (verdict, coverage, formatted savings, run shape), which is installed as is.
 * Call only with a payload `unsupportedPayloadReason` accepts. Split out of main-export.tsx so it's testable
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
  store.setState({ exportMode: true, exportProvenance: data.provenance });
  store.getState().setCatalog(catalog);
  store.getState().setConfigFindings(data.configFindings);
  // The interpretation indexes the findings in catalog-then-config order, the
  // order the producer passed them to interpretRun.
  store.getState().setInterpretation({ data: data.interpretation, findings: [...catalog, ...data.configFindings] });
  store.getState().setSkippedLines(data.skippedLines);
  store.getState().setStatus('ready');
}
