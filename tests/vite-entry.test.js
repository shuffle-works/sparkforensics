import { existsSync } from 'node:fs';
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

  it('includes the tuning reference in the production bundle', () => {
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/intro.html'))).toBe(true);
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/bottleneck-skew.html'))).toBe(true);
  });
});
