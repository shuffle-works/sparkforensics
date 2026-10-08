import { existsSync, readdirSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

describe('Vite entry template', () => {
  it('mounts the React development entry point', async () => {
    const template = await readFile(resolve(root, 'index.html'), 'utf8');

    expect(template).toContain('<div id="root"></div>');
    expect(template).toContain('<script type="module" src="/src/main.tsx"></script>');
  });

  it('uses relative asset URLs in the production bundle', async () => {
    const built = await readFile(resolve(root, 'dist/index.html'), 'utf8');

    expect(built).not.toMatch(/\b(?:src|href)="\/assets\//);
    expect(built).toMatch(/\b(?:src|href)="\.\/assets\//);
  });

  it('ships the single-file HTML export template as a static file beside the app', async () => {
    const template = await readFile(resolve(root, 'dist/export-template.html'), 'utf8');
    // The dashboard's HTML download splices the run into exactly this one tag
    // (src/export/single-file.ts); everything else must already be inline.
    const parts = template.split('<script src="./data.js"></script>');
    expect(parts).toHaveLength(2);
    expect(parts.join('')).not.toMatch(/<link\b[^>]*\bhref="\.\//);
  });

  describe('vendor chunk layout', () => {
    const assets = resolve(root, 'dist/assets');
    const chunkFile = (name) => readdirSync(assets).find((f) => f.startsWith(`${name}-`) && f.endsWith('.js'));
    const chunkText = (file) => readFile(resolve(assets, file), 'utf8');
    // The chunks a chunk imports statically, and the chunks it pulls in, as the browser loads them.
    const importsOf = (text) => [...text.matchAll(/(?:from|import)\s*["']\.\/([^"']+\.js)["']/g)].map((m) => m[1]);
    async function staticClosure(file) {
      const seen = new Set();
      const queue = [file];
      while (queue.length > 0) {
        const next = queue.pop();
        if (seen.has(next)) continue;
        seen.add(next);
        queue.push(...importsOf(await chunkText(next)));
      }
      return seen;
    }
    const vendorNames = (files) => [...files].map((f) => /^([a-z0-9-]+-vendor)-/.exec(f.split('/').pop())?.[1]).filter(Boolean).sort();

    it('preloads only react-vendor among the vendor chunks on the landing page', async () => {
      const html = await readFile(resolve(root, 'dist/index.html'), 'utf8');
      const loaded = [...html.matchAll(/(?:src|href)="\.\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
      expect(loaded.length).toBeGreaterThan(0);
      expect(vendorNames(loaded)).toEqual(['react-vendor']);
      // The entry chunk's own static imports are the other half of what a visitor downloads.
      const entry = loaded.find((f) => f.startsWith('index-'));
      expect(vendorNames(await staticClosure(entry))).toEqual(['react-vendor']);
    });

    it('keeps the charts chunk free of the plan-graph chunk, and the other way round, sharing d3 instead', async () => {
      const charts = await chunkText(chunkFile('charts-vendor'));
      const planGraph = await chunkText(chunkFile('plan-graph-vendor'));
      expect(importsOf(charts).filter((f) => f.startsWith('plan-graph-vendor-'))).toEqual([]);
      expect(importsOf(planGraph).filter((f) => f.startsWith('charts-vendor-'))).toEqual([]);
      expect(importsOf(charts).some((f) => f.startsWith('d3-vendor-'))).toBe(true);
      expect(importsOf(planGraph).some((f) => f.startsWith('d3-vendor-'))).toBe(true);
    });

    it('loads no plan-graph chunk or stylesheet with the Dashboard', async () => {
      const dashboard = chunkFile('Dashboard');
      expect(vendorNames(await staticClosure(dashboard))).toEqual(expect.not.arrayContaining(['plan-graph-vendor']));
      // The entry chunk preloads a lazily imported view's dependencies from its map of file lists.
      const index = await chunkText(chunkFile('index'));
      const table = JSON.parse(/m\.f\|\|\(m\.f=(\[[^\]]*\])/.exec(index)[1]);
      const rows = [...index.matchAll(/__vite__mapDeps\(\[([0-9,]+)\]\)/g)].map((m) => m[1].split(',').map(Number));
      const dashboardRow = rows.find((row) => table[row[0]]?.includes('Dashboard-'));
      expect(dashboardRow).toBeDefined();
      expect(dashboardRow.map((i) => table[i]).filter((f) => f.includes('plan-graph-vendor'))).toEqual([]);
    });
  });

  it('includes the tuning reference in the production bundle', () => {
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/intro.html'))).toBe(true);
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/bottleneck-skew.html'))).toBe(true);
  });
});
