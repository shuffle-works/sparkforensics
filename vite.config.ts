import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { copyDocsSite } from './vite-plugins/copy-docs-site';
import { coreSourceHash } from './packages/core/src/load-vendored.js';

// Provenance the dashboard stamps into its HTML exports (src/build-info.ts): the web app's
// version and the build id of the core compiled into this bundle, the same source hash the
// CLI reports for the core it loads.
const webVersion: string = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version;
const coreBuildId = coreSourceHash(path.resolve(__dirname, 'packages/core/src'));

const DOCS_SITE_MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
};

function docsSiteNotBuiltResponse(res: import('node:http').ServerResponse) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(
    '<!doctype html><meta charset="utf-8"><title>Docs not built</title>' +
      '<h1>Docs site not built</h1>' +
      '<p>Run <code>npm run docs:build</code> to generate docs-site/.vitepress/dist, then reload.</p>',
  );
}

// copyDocsSite() only runs on build, so /docs/ links get the SPA fallback
// (index.html) instead of a 404 during `npm run dev`. Mirror /docs/ from the
// built docs site during dev too.
function serveDocsSiteDev() {
  return {
    name: 'serve-docs-site-dev',
    apply: 'serve' as const,
    configureServer(server: ViteDevServer) {
      const docsDist = path.resolve(__dirname, 'docs-site/.vitepress/dist');
      server.middlewares.use('/docs', (req, res) => {
        if (!existsSync(docsDist)) {
          docsSiteNotBuiltResponse(res);
          return;
        }

        // Mounting at '/docs' strips that prefix from req.url, so req.url
        // here is already relative to docsDist.
        const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
        const candidates = urlPath.endsWith('/')
          ? [urlPath + 'index.html']
          : [urlPath, `${urlPath}.html`, `${urlPath}/index.html`];

        for (const candidate of candidates) {
          const filePath = path.normalize(path.join(docsDist, candidate));
          if (!filePath.startsWith(docsDist)) continue; // guard against path traversal
          if (existsSync(filePath) && statSync(filePath).isFile()) {
            const ext = path.extname(filePath);
            res.setHeader('Content-Type', DOCS_SITE_MIME_TYPES[ext] ?? 'application/octet-stream');
            createReadStream(filePath).pipe(res);
            return;
          }
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end('<!doctype html><meta charset="utf-8"><title>Not found</title><h1>404 Not Found</h1>');
      });
    },
  };
}

export default defineConfig({
  base: './',
  define: {
    __SPARKFORENSICS_WEB_VERSION__: JSON.stringify(webVersion),
    __SPARKFORENSICS_CORE_BUILD_ID__: JSON.stringify(coreBuildId),
  },
  plugins: [react(), tailwindcss(), copyDocsSite('dist'), serveDocsSiteDev()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      output: {
        // Each group names a vendor chunk. A group also captures the
        // dependencies of its modules that no higher-priority group claims, so
        // react-vendor (highest priority) must own everything the landing
        // page shares with recharts and @xyflow: react and react-dom (CJS
        // dependencies of both), and clsx (used by the app's own class
        // helper). Without that, the entry chunk imports them from
        // charts-vendor or plan-graph-vendor, and both lazy-only chunks are
        // preloaded on the landing page.
        // recharts and @xyflow also share d3 modules (d3-interpolate and its
        // dependencies). Left to the lower-priority group that claims the first
        // importer, one of the two chunks would import them from the other, and
        // opening a log (which preloads the charts chunk with the Dashboard)
        // would preload the plan-graph chunk too. d3-vendor owns them instead,
        // so each of the two imports only this small shared chunk.
        // recharts is what pushes Dashboard over 500kB (eagerly pulled by
        // always-mounted widgets); splitting it out drops Dashboard under it.
        codeSplitting: {
          groups: [
            { name: 'react-vendor', test: /node_modules\/(react|react-dom|scheduler|use-sync-external-store|clsx)\//, priority: 4 },
            { name: 'd3-vendor', test: /node_modules\/(d3-[a-z-]+|internmap)\//, priority: 3 },
            { name: 'plan-graph-vendor', test: /node_modules\/(@xyflow|@dagrejs)\//, priority: 2 },
            { name: 'charts-vendor', test: /node_modules\/recharts\//, priority: 1 },
          ],
        },
      },
    },
  },
  worker: { format: 'es' },
});
