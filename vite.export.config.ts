import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyDocsSite } from './vite-plugins/copy-docs-site';
import { EXPORT_TEMPLATE_FILE } from './src/export/template-asset';

// Vite names an HTML build output after the source file's own path relative
// to the config root, not after any rollupOptions.input key: building from
// index.export.html always emits dist-export/index.export.html. The CLI's
// --export-html flag (and Task 9's vendoring script) expect index.html, so
// rename the emitted file in place once the bundle is written.
//
// Vite also unconditionally marks the module script tag `crossorigin` (no
// config knob to opt out: it's hardcoded in vite's build-html plugin).
// Before vite-plugin-singlefile was added, that mattered a lot: a bare
// `crossorigin` attribute on a `src`-referenced module/modulepreload tag
// forces the browser to fetch it in CORS mode, and Chromium refuses
// CORS-mode requests entirely under the `file://` origin ("Cross origin
// requests are only supported for protocol schemes: chrome,
// chrome-untrusted, data, http, https"), so the whole page failed to render.
// Now that everything is inlined, the plugin's own script-replacement keeps
// whatever attributes surrounded the original `src=`, so `crossorigin`
// survives onto the resulting src-less inline `<script type="module">` tag.
// Verified empirically (see Task 12's report) that this leftover attribute
// is inert there (browsers only act on `crossorigin` when fetching an
// external resource) and no `crossorigin` occurrence remains anywhere else
// in the built HTML. Kept purely for hygiene: strip the one vestigial
// occurrence rather than ship a meaningless attribute.
function stripCrossorigin(html: string): string {
  return html.replace(/\s+crossorigin(="[^"]*")?/g, '');
}

// `--mode template` (run by `npm run build`) builds the same app as the
// template for the dashboard's single-file HTML download: no docs copy (one
// downloaded file can't carry the docs site, so that export links to the
// published docs instead), no public/ copy, and the favicon inlined as a data
// URI so the downloaded file makes no relative request at all. Only the HTML
// is kept, as dist/<EXPORT_TEMPLATE_FILE>; the rest of the scratch outDir
// (worker chunks the export app never starts) is discarded.
const TEMPLATE_OUT_DIR = 'dist-export-template';

function inlineFavicon(html: string): string {
  const faviconHref = 'href="./favicon.svg"';
  if (!html.includes(faviconHref)) throw new Error(`[rename-export-entry] ${faviconHref} not found in the export template`);
  const svg = readFileSync(path.resolve(__dirname, 'public/favicon.svg'));
  return html.replace(faviconHref, `href="data:image/svg+xml;base64,${svg.toString('base64')}"`);
}

function renameExportEntry(templateOnly: boolean) {
  return {
    name: 'rename-export-entry',
    apply: 'build' as const,
    closeBundle() {
      const outDir = path.resolve(__dirname, templateOnly ? TEMPLATE_OUT_DIR : 'dist-export');
      const exportHtmlPath = path.join(outDir, 'index.export.html');
      const html = stripCrossorigin(readFileSync(exportHtmlPath, 'utf8'));
      if (templateOnly) {
        mkdirSync(path.resolve(__dirname, 'dist'), { recursive: true });
        writeFileSync(path.resolve(__dirname, 'dist', EXPORT_TEMPLATE_FILE), inlineFavicon(html));
        rmSync(outDir, { recursive: true, force: true });
        return;
      }
      renameSync(exportHtmlPath, path.join(outDir, 'index.html'));
      writeFileSync(path.join(outDir, 'index.html'), html);
    },
  };
}

export default defineConfig(({ mode }) => {
  const templateOnly = mode === 'template';
  return {
    base: './',
    publicDir: templateOnly ? false : 'public',
    plugins: [
      react(),
      tailwindcss(),
      ...(templateOnly ? [] : [copyDocsSite('dist-export', { rewriteRelative: true })]),
      // Inlines every emitted JS/CSS asset directly into index.html so the
      // export never issues a `type="module" src=`/modulepreload request:
      // those are unconditionally CORS-mode fetches, which Chromium refuses
      // outright under the opaque "null" origin every `file://` page has.
      // `enforce: 'post'` (set by the plugin itself) makes it run its
      // config/generateBundle hooks after the other plugins regardless of
      // array position; it's placed after copyDocsSite and before
      // renameExportEntry() to match the pipeline order: bundle, inline,
      // then rename+cleanup the final HTML.
      viteSingleFile(),
      renameExportEntry(templateOnly),
    ],
    resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
    build: {
      outDir: templateOnly ? TEMPLATE_OUT_DIR : 'dist-export',
      target: 'es2022',
      // No `manualChunks` here: vite-plugin-singlefile inlines the whole
      // bundle into one file (it also forces a single JS chunk via its
      // `config` hook), so per-vendor chunk splitting has no effect.
      rollupOptions: {
        input: path.resolve(__dirname, 'index.export.html'),
      },
    },
  };
});
