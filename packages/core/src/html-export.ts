import type { AnalyzedRun } from './analyzed-run.ts';
import { buildExportRunData, CORE_VERSION, encodeCollections, type ExportProvenance, type ExportRunData } from './export-data.ts';
import { redactRun } from './redact.ts';
import { gzipSync, strToU8 } from './vendor/fflate.js';

// Shared by the two producers of the self-contained HTML dashboard: the CLI's
// --export-html (writeHtmlExport, which writes a data.js next to the template)
// and the dashboard's "Download HTML" item (EvidenceExport.tsx, which inlines
// the same statement into one downloaded file). Both encode through
// encodeRunPayload here and wrap it with runPayloadScript (run-payload.ts); the
// export app's decodeRunPayload (src/export/hydrate-store.ts) reverses it.

/** The run data an HTML export carries: the serialized model, the config audit, and the whole
 * interpretation layer (verdict, coverage, formatted savings, run shape) the run holds, so the
 * bundle that opens the file renders this core's conclusions instead of deriving its own. With
 * `redact`, the run is pseudonymized first and its interpretation derived from the redacted
 * run, so text the interpretation truncates (Spark's failure reason) can never keep part of an
 * identifier the redactor cannot match. */
export function buildHtmlExportData(
  run: AnalyzedRun,
  { redact, buildId, producer }: { redact: boolean; buildId: string; producer: string },
): ExportRunData {
  const provenance: ExportProvenance = { coreVersion: CORE_VERSION, buildId, producer };
  return buildExportRunData(redact ? redactRun(run) : run, provenance);
}

// String.fromCharCode spreads its arguments onto the stack; a multi-MB payload
// in one call overflows it, so convert in slices.
const BASE64_CHUNK_BYTES = 0x8000;

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(i, i + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}

/** gzip + base64 of the JSON payload, runnable in the browser (fflate, no
 * node:zlib). strToU8 encodes UTF-8, matching decodeRunPayload's decode. */
export function encodeRunPayload(data: ExportRunData): string {
  return bytesToBase64(gzipSync(strToU8(JSON.stringify(encodeCollections(data)))));
}
