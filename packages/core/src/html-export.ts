import { auditConfig } from './analyzer.ts';
import { buildExportRunData, type ExportRunData } from './export-data.ts';
import { redactExportData } from './redact.ts';
import { gzipSync, strToU8 } from './vendor/fflate.js';
import type { AppModel, Finding } from './types.ts';

// Shared by the two producers of the self-contained HTML dashboard: the CLI's
// --export-html (writeHtmlExport, which writes a data.js next to the template)
// and the dashboard's "Download HTML" item (EvidenceExport.tsx, which inlines
// the same statement into one downloaded file). The export app's
// decodeRunPayload (src/export/hydrate-store.ts) reverses the encoding.

/** The run data an HTML export carries: the precomputed config audit plus the
 * serialized model, pseudonymized when `redact` is on. */
export function buildHtmlExportData(
  appModel: AppModel,
  catalog: Finding[],
  skippedLines: number,
  { redact }: { redact: boolean },
): ExportRunData {
  const configFindings = auditConfig(appModel.app);
  const data = buildExportRunData(appModel, catalog, configFindings, skippedLines);
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

/** The one JavaScript statement that hands an encoded payload to the export
 * app. base64's alphabet (A-Za-z0-9+/=) can't contain "<" or a quote, so log
 * free text can't inject a "</script>" break-out or end the string literal:
 * the statement is safe to place inside an inline <script> with no escaping.
 * That only holds while `base64` really is base64; keep any new encoding
 * inside that alphabet or escape it here. */
export function runPayloadScript(base64: string): string {
  return `window.__SPARKFORENSICS_RUN_GZ__ = "${base64}";`;
}
