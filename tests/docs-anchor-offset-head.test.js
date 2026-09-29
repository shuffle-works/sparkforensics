import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import docsConfig from '../docs-site/.vitepress/config.ts';

// VitePress's renderHead minifies each inline head script with its own Vite's
// esbuild transform before writing it into every built page. Reproduce that
// on the script config.ts ships, since the built page is what the hub reads.
const vitepressVite = join(dirname(createRequire(import.meta.url).resolve('vitepress/package.json')), 'node_modules/vite');
const { transformWithEsbuild } = await import(pathToFileURL(join(vitepressVite, 'dist/node/index.js')).href);

describe('docs anchor offset head script', () => {
  it('keeps the hub bar marker out of the emitted page source', async () => {
    const scripts = docsConfig.head.filter(([tag]) => tag === 'script');
    expect(scripts).toHaveLength(1);
    const [[, , headScript]] = scripts;
    const emitted = (await transformWithEsbuild(headScript, 'inline-script.js', { minify: true })).code;
    expect(emitted).toContain('data-sf-anchor-offset');
    // The hub skips injecting its bar into any page whose source contains it.
    expect(emitted).not.toContain('data-shuffle-product-bar');
  });
});
