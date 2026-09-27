// How an encoded HTML-export payload reaches the export app: a window global
// that data.js (or the inlined script) assigns and main-export.tsx reads.
// Dependency-free, so the export bundle can read the global without pulling in
// the producer side (html-export.ts and the analysis it runs).

/** The window global the payload statement assigns and the export app reads. */
export const RUN_PAYLOAD_GLOBAL = '__SPARKFORENSICS_RUN_GZ__';

/** The one JavaScript statement that hands an encoded payload to the export
 * app. base64's alphabet (A-Za-z0-9+/=) can't contain "<" or a quote, so log
 * free text can't inject a "</script>" break-out or end the string literal:
 * the statement is safe to place inside an inline <script> with no escaping.
 * That only holds while `base64` really is base64; keep any new encoding
 * inside that alphabet or escape it here. */
export function runPayloadScript(base64: string): string {
  return `window.${RUN_PAYLOAD_GLOBAL} = "${base64}";`;
}
