import { runPayloadScript } from '@sparkforensics/core/html-export.ts';
import type { DocsBases } from '@/view/docs-href';

export { EXPORT_TEMPLATE_FILE } from './template-asset';

// The built export template is already self-contained (vite-plugin-singlefile
// inlines every asset) except for this one tag, which the CLI satisfies by
// writing a data.js file beside it. See index.export.html.
const DATA_SCRIPT_TAG = '<script src="./data.js"></script>';

/** Turns the built export template into one downloadable HTML file: the
 * data.js tag becomes an inline script carrying the payload, plus the docs
 * locations the export's links should open when given (a lone file has no
 * docs/ folder next to it, see src/view/docs-href.ts). Throws when the template doesn't
 * have exactly one data.js tag, e.g. a dev server answering the template
 * request with the app's own index.html. */
export function inlineRunPayload(templateHtml: string, base64: string, docsBases: DocsBases | null): string {
  const first = templateHtml.indexOf(DATA_SCRIPT_TAG);
  if (first === -1 || templateHtml.indexOf(DATA_SCRIPT_TAG, first + 1) !== -1) {
    throw new Error('The HTML export template is missing or malformed in this build.');
  }
  // runPayloadScript's base64 can't contain "<". The docs URLs are JSON, whose
  // only way to hold "<" is escaped here as \u003c, so neither can close the
  // inline <script>.
  const bases = docsBases
    ? `window.__SPARKFORENSICS_DOCS_BASES__ = ${JSON.stringify(docsBases).replace(/</g, '\\u003c')};\n`
    : '';
  const inline = `<script>${bases}${runPayloadScript(base64)}</script>`;
  return templateHtml.slice(0, first) + inline + templateHtml.slice(first + DATA_SCRIPT_TAG.length);
}
