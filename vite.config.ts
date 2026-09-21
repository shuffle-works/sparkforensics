import { defineConfig, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { copyDocsSite } from './vite-plugins/copy-docs-site';

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
  plugins: [react(), tailwindcss(), copyDocsSite('dist'), serveDocsSiteDev()],
  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },
  build: {
    outDir: 'dist',
    target: 'es2022',
    rollupOptions: {
      output: {
        // @xyflow/@dagrejs already isolate into the lazy PlanGraphRoute chunk;
        // naming them keeps that true if a non-lazy import ever creeps in.
        // recharts is what pushes Dashboard over 500kB (eagerly pulled by
        // always-mounted widgets); splitting it out drops Dashboard under it.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@xyflow') || id.includes('@dagrejs')) return 'plan-graph-vendor';
          if (id.includes('recharts')) return 'charts-vendor';
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'react-vendor';
          return undefined;
        },
      },
    },
  },
  worker: { format: 'es' },
});
