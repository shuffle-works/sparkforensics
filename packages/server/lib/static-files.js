import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, normalize, sep, extname } from 'node:path';

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

export function resolveStaticRoot(dir) {
  const bundled = join(dir, 'public');
  // Monorepo dev fallback (no public/ yet): dir is packages/server, and the
  // Vite build output lives at the repo root, two levels up.
  return existsSync(bundled) ? bundled : join(dir, '..', '..', 'dist');
}

export async function serveStatic(req, res, root) {
  // Deliberately not via `new URL()`: its dot-segment resolution collapses
  // `/../../etc/passwd` before we see it, sailing a traversal past the guard
  // below as a 404 instead of a 403.
  const pathname = decodeURIComponent(req.url.split('?')[0]);
  const stripped = pathname.replace(/^\/+/, '');
  // Any directory-style request (trailing slash, including '/' itself) seeks
  // that directory's index.html, same as a browser navigating to it directly.
  const relative = pathname.endsWith('/') ? `${stripped}index.html` : stripped;
  const target = normalize(join(root, relative));

  // Path-traversal guard: the resolved path must stay within root.
  const rootPrefix = normalize(root + sep);
  if (target !== normalize(root) && !target.startsWith(rootPrefix)) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  let data;
  try {
    data = await readFile(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    return;
  }

  const type = CONTENT_TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type });
  res.end(data);
}
