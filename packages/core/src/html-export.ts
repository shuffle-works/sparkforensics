import { auditConfig } from './analyzer.ts';
import { buildExportRunData, CORE_VERSION, type ExportProvenance, type ExportRunData } from './export-data.ts';
import { redactExportData } from './redact.ts';
import { interpretRun } from './run-interpretation.ts';
import { gzipSync, strToU8 } from './vendor/fflate.js';
import type { AppModel, Finding } from './types.ts';

// Shared by the two producers of the self-contained HTML dashboard: the CLI's
// --export-html (writeHtmlExport, which writes a data.js next to the template)
// and the dashboard's "Download HTML" item (EvidenceExport.tsx, which inlines
// the same statement into one downloaded file). Both encode through
// encodeRunPayload here and wrap it with runPayloadScript (run-payload.ts); the
// export app's decodeRunPayload (src/export/hydrate-store.ts) reverses it.

/** The run data an HTML export carries: the serialized model, the config
 * audit, and the whole interpretation layer (verdict, coverage, formatted
 * savings, run shape) computed here, so the bundle that opens the file renders
 * this core's conclusions instead of deriving its own. Redaction runs last and
 * walks the interpretation too, so a quoted reason or copied step gets the same
 * pseudonyms as the findings it came from. */
export function buildHtmlExportData(
  appModel: AppModel,
  catalog: Finding[],
  skippedLines: number,
  { redact, buildId, producer }: { redact: boolean; buildId: string; producer: string },
): ExportRunData {
  const configFindings = auditConfig(appModel.app);
  const interpretation = interpretRun(appModel, catalog, configFindings);
  const provenance: ExportProvenance = { coreVersion: CORE_VERSION, buildId, producer };
  const data = buildExportRunData(appModel, catalog, configFindings, skippedLines, interpretation, provenance);
  return redact ? redactExportData(data) : data;
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
  return bytesToBase64(gzipSync(strToU8(JSON.stringify(data))));
}
