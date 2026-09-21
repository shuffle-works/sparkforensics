import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveStaticRoot, serveStatic } from '../lib/static-files.js';

let tmp, pkgDir, rootDir;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), 'els-static-'));
  // Simulate a published package: <pkgDir>/public with index.html
  pkgDir = join(tmp, 'pkg');
  rootDir = join(pkgDir, 'public');
  mkdirSync(rootDir, { recursive: true });
  writeFileSync(join(rootDir, 'index.html'), '<!doctype html><title>home</title>');
  mkdirSync(join(rootDir, 'src'), { recursive: true });
  writeFileSync(join(rootDir, 'src', 'app.js'), 'export const x = 1;');
  mkdirSync(join(rootDir, 'docs'), { recursive: true });
  writeFileSync(join(rootDir, 'docs', 'index.html'), '<!doctype html><title>docs home</title>');
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function fakeRes() {
  return {
    statusCode: null, headers: null, chunks: [], ended: false,
    writeHead(s, h) { this.statusCode = s; this.headers = h || {}; },
    write(c) { this.chunks.push(c); },
    end(c) { if (c) this.chunks.push(c); this.ended = true; },
    bodyText() { return this.chunks.map(c => (typeof c === 'string' ? c : Buffer.from(c).toString('utf8'))).join(''); },
  };
}

describe('resolveStaticRoot', () => {
  it('prefers the bundled public/ dir when it exists', () => {
    expect(resolveStaticRoot(pkgDir)).toBe(rootDir);
  });
  it('falls back to the repo root\'s dist/ (Vite build output) when public/ is absent', () => {
    const bare = join(tmp, 'bare');
    mkdirSync(bare, { recursive: true });
    expect(resolveStaticRoot(bare)).toBe(join(bare, '..', '..', 'dist'));
  });
});

describe('resolveStaticRoot + serveStatic: dist/ fallback', () => {
  it('serves the Vite build\'s dist/index.html at / when public/ is absent', async () => {
    // resolveStaticRoot(dir) looks for <dir>/public, falling back to
    // <dir>/../../dist (the real repo layout: packages/server/ + repo-root dist/).
    const projDir = join(tmp, 'proj');
    const serverDir = join(projDir, 'packages', 'server');
    const distDir = join(projDir, 'dist');
    mkdirSync(serverDir, { recursive: true });
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, 'index.html'), '<!doctype html><title>dist build</title>');

    const root = resolveStaticRoot(serverDir);
    expect(root).toBe(distDir);

    const res = fakeRes();
    await serveStatic({ url: '/' }, res, root);
    expect(res.statusCode).toBe(200);
    expect(res.bodyText()).toMatch(/dist build/);
  });
});

describe('serveStatic', () => {
  it('serves index.html for /', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/' }, res, rootDir);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.bodyText()).toMatch(/home/);
  });
  it('serves a nested directory\'s index.html for a trailing-slash request', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/docs/' }, res, rootDir);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.bodyText()).toMatch(/docs home/);
  });
  it('returns 404 for the same directory requested without a trailing slash', async () => {
    // No redirect/normalization for the no-slash form: matches a real
    // directory read attempt (EISDIR), same as any other missing file.
    const res = fakeRes();
    await serveStatic({ url: '/docs' }, res, rootDir);
    expect(res.statusCode).toBe(404);
  });
  it('serves a .js file with a JS content-type', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/src/app.js' }, res, rootDir);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
  });
  it('returns 404 for a missing file', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/nope.js' }, res, rootDir);
    expect(res.statusCode).toBe(404);
  });
  it('rejects path traversal with 403', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/../../etc/passwd' }, res, rootDir);
    expect(res.statusCode).toBe(403);
    expect(res.bodyText()).toBe('Forbidden');
  });
  it('rejects %2e%2e%2f-encoded path traversal with 403', async () => {
    const res = fakeRes();
    // decodeURIComponent runs before the guard check, so this collapses to
    // the same '/../../etc/passwd' the guard already catches.
    await serveStatic({ url: '/%2e%2e%2f%2e%2e%2fetc/passwd' }, res, rootDir);
    expect(res.statusCode).toBe(403);
    expect(res.bodyText()).toBe('Forbidden');
  });
  it('rejects mixed-encoding (..%2f) path traversal with 403', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/..%2f..%2fetc/passwd' }, res, rootDir);
    expect(res.statusCode).toBe(403);
    expect(res.bodyText()).toBe('Forbidden');
  });
  it('rejects null-byte traversal with 403', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/../../etc/passwd%00.png' }, res, rootDir);
    expect(res.statusCode).toBe(403);
    expect(res.bodyText()).toBe('Forbidden');
  });
  it('returns 404 (not a crash or file leak) for a lone null byte in the path', async () => {
    const res = fakeRes();
    await serveStatic({ url: '/foo%00.js' }, res, rootDir);
    expect(res.statusCode).toBe(404);
  });
});
