import { store } from '@/store/store';
import {
  EXPORT_DATA_SCHEMA_VERSION, READABLE_EXPORT_SCHEMA_VERSIONS, reviveExportCollections, upgradeExportPayload,
  type ExportRunData, type ExportRunDataV3,
} from '@sparkforensics/core/export-data.ts';
import { deserializeRun } from '@sparkforensics/core/run-serialization.ts';
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
  { key: 'stages', present: Array.isArray, label: 'stage list' },
  { key: 'sql', present: Array.isArray, label: 'SQL execution list' },
  { key: 'jobs', present: Array.isArray, label: 'job list' },
];

/** Why this bundle cannot render `payload`, or null when it can. The bundle reads the payload
 * version it was built for and the older ones `upgradeExportPayload` converts. Any other version is
 * refused whole rather than rendered partially: an older one lacks the precomputed conclusions (this
 * bundle has no analysis to fill them in), and a newer one may carry fields it would silently drop.
 * A payload of a readable version missing one of its precomputed results is refused the same way. */
export function unsupportedPayloadReason(payload: unknown): string | null {
  const fields: Record<string, unknown> = isObject(payload) ? payload as Record<string, unknown> : {};
  const version = fields.schemaVersion;
  if (typeof version !== 'number' || !READABLE_EXPORT_SCHEMA_VERSIONS.includes(version)) {
    const found = typeof version === 'number' ? `version ${version}` : 'an unknown version';
    return `This file holds export data format ${found}, but this viewer only reads ${READABLE_EXPORT_SCHEMA_VERSIONS.map((readable) => `version ${readable}`).join(' and ')}. ${REEXPORT_HINT}`;
  }
  const missing = REQUIRED_RESULTS.filter(({ key, present }) => !present(fields[key])).map(({ label }) => label);
  if (missing.length === 0) return null;
  return `This file is missing the ${missing.join(' and ')} this viewer needs. ${REEXPORT_HINT}`;
}

/** Installs the run an export payload carries and flips the store to `exportMode`. Everything
 * analytical arrives precomputed by the producer: findings, config audit, and the interpretation
 * (verdict, coverage, formatted savings, run shape), installed as is. Call only with a payload
 * `unsupportedPayloadReason` accepts. Split out of main-export.tsx so it's testable without
 * mounting React. */
export function hydrateExportStore(payload: ExportRunData | ExportRunDataV3): void {
  const data = payload.schemaVersion === EXPORT_DATA_SCHEMA_VERSION ? payload as ExportRunData : upgradeExportPayload(payload as ExportRunDataV3);
  store.setState({ exportMode: true, exportProvenance: data.provenance });
  store.getState().installRun(deserializeRun(data), 'export');
}

const UNREADABLE_PAYLOAD_REASON =
  'The run data in this file is missing or unreadable. Keep data.js in the same folder as index.html, or export the run again.';

/** Decodes the data.js payload and hydrates the store from it. Returns null once the dashboard
 * can render, or the reason it cannot: a payload version or shape this bundle refuses, or a
 * payload that is missing (data.js not loaded) or damaged (truncated gzip, invalid JSON, wrong
 * shape). Never throws, so the caller always has a view to show. */
export function loadExportPayload(encoded: unknown): string | null {
  if (typeof encoded !== 'string' || encoded === '') return UNREADABLE_PAYLOAD_REASON;
  try {
    const payload = decodeRunPayload(encoded);
    const unsupported = unsupportedPayloadReason(payload);
    if (unsupported != null) return unsupported;
    hydrateExportStore(payload as ExportRunData | ExportRunDataV3);
    return null;
  } catch (error) {
    console.error('Export payload could not be loaded:', error);
    return UNREADABLE_PAYLOAD_REASON;
  }
}
