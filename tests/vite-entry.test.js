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

  it('includes the tuning reference in the production bundle', () => {
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/intro.html'))).toBe(true);
    expect(existsSync(resolve(root, 'dist/docs/tuning-reference/bottleneck-skew.html'))).toBe(true);
  });
});
