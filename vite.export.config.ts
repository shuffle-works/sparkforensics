import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { copyDocsSite } from './vite-plugins/copy-docs-site';

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

function renameExportEntry() {
  return {
    name: 'rename-export-entry',
    apply: 'build' as const,
    closeBundle() {
      const exportHtmlPath = path.resolve(__dirname, 'dist-export/index.export.html');
      const finalHtmlPath = path.resolve(__dirname, 'dist-export/index.html');
      renameSync(exportHtmlPath, finalHtmlPath);
      const html = readFileSync(finalHtmlPath, 'utf8');
      writeFileSync(finalHtmlPath, stripCrossorigin(html));
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [
    react(),
    tailwindcss(),
    copyDocsSite('dist-export', { rewriteRelative: true }),
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
    renameExportEntry(),
  ],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist-export',
    target: 'es2022',
    // No `manualChunks` here: vite-plugin-singlefile inlines the whole
    // bundle into one file (it also forces a single JS chunk via its
    // `config` hook), so per-vendor chunk splitting has no effect.
    rollupOptions: {
      input: path.resolve(__dirname, 'index.export.html'),
    },
  },
});
