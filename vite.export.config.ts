import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { EXPORT_TEMPLATE_FILE } from './src/export/template-asset';
import { exportAnalysisGuard } from './scripts/export-analysis-guard.mjs';
import type { Plugin } from 'vite';

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

// Neither build copies the docs site: an exported dashboard renders its docs
// references as plain text (see DocsLink), so nothing in it links to docs/.
//
// `--mode template` (run by `npm run build`) builds the same app as the
// template for the dashboard's single-file HTML download: no public/ copy,
// and the favicon inlined as a data URI so the downloaded file makes no
// relative request at all. Only the HTML
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

// Live-only modules and the stand-ins the export build resolves them to
// (src/export/live-only-stubs/): the exported dashboard hides every control
// that reaches them, and keeping the real ones out of the graph keeps their
// analysis (analyzer, evidence report, html export) and the ingest path out of
// the file. Matched on the resolved path, so every import style is caught.
const LIVE_ONLY_STUBS: Record<string, string> = {
  'src/store/useIngest.ts': 'src/export/live-only-stubs/useIngest.ts',
  'src/view/useRecentFiles.ts': 'src/export/live-only-stubs/useRecentFiles.ts',
  'src/view/EvidenceExport.tsx': 'src/export/live-only-stubs/EvidenceExport.tsx',
  'src/view/core-usage-histogram-data.ts': 'src/export/live-only-stubs/core-usage-histogram-data.ts',
};

function swapLiveOnlyModules(): Plugin {
  return {
    name: 'swap-live-only-modules',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer) return null;
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
      if (!resolved) return null;
      const repoPath = path.relative(__dirname, resolved.id.split('?')[0]).split(path.sep).join('/');
      const stub = LIVE_ONLY_STUBS[repoPath];
      return stub ? path.resolve(__dirname, stub) : resolved;
    },
  };
}

// `--mode guard` (tests/export-analysis-guard.test.ts) only bundles in memory
// to run exportAnalysisGuard over the real graph: nothing is written or renamed.
export default defineConfig(({ mode }) => {
  const templateOnly = mode === 'template';
  const guardOnly = mode === 'guard';
  return {
    base: './',
    publicDir: templateOnly ? false : 'public',
    plugins: [
      swapLiveOnlyModules(),
      react(),
      tailwindcss(),
      // Inlines every emitted JS/CSS asset directly into index.html so the
      // export never issues a `type="module" src=`/modulepreload request:
      // those are unconditionally CORS-mode fetches, which Chromium refuses
      // outright under the opaque "null" origin every `file://` page has.
      // `enforce: 'post'` (set by the plugin itself) makes it run its
      // config/generateBundle hooks after the other plugins regardless of
      // array position; it's placed before renameExportEntry() to match the
      // pipeline order: bundle, inline, then rename+cleanup the final HTML.
      viteSingleFile(),
      // Fails the build when the graph reaches analysis or the live ingest path.
      exportAnalysisGuard(__dirname),
      ...(guardOnly ? [] : [renameExportEntry(templateOnly)]),
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
